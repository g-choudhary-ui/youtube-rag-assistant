from __future__ import annotations

import os
import re
import threading
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from huggingface_hub import InferenceClient

# Load environment variables from .env if present
load_dotenv()

# ============================================================
# PATHS AND CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).resolve().parents[2]
TRANSCRIPT_PATH = BASE_DIR / "transcript.txt"

# Gemini model for LLM generation (free tier)
GEMINI_MODEL_ID = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
# HF only used for embeddings (with lexical fallback if it fails)
EMBEDDING_MODEL_ID = os.getenv("HF_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

TOP_K_CANDIDATES = 4
MAX_SUMMARY_DOCUMENTS = 4
MAX_COMPRESSION_SENTENCES = 10

_hf_client: InferenceClient | None = None
_hf_client_lock = threading.Lock()


def get_hf_client() -> InferenceClient:
    """Return a cached HuggingFace InferenceClient (used only for embeddings)."""
    global _hf_client
    with _hf_client_lock:
        if _hf_client is None:
            token = os.getenv("HF_TOKEN")
            _hf_client = InferenceClient(api_key=token)
        return _hf_client


def _call_gemini_api(prompt: str, max_output_tokens: int = 250, json_mode: bool = False) -> str:
    """Call Gemini REST API directly using requests (no SDK required).
    Retries up to 3 times on 503 overload errors.
    """
    import time
    import requests as req

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError(
            "GEMINI_API_KEY environment variable is missing. "
            "Get a free key at https://aistudio.google.com/app/apikey"
        )
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL_ID}:generateContent?key={api_key}"
    )
    gen_config: dict = {
        "maxOutputTokens": max_output_tokens,
        "temperature": 0.2,
    }
    if json_mode:
        gen_config["responseMimeType"] = "application/json"

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": gen_config,
    }

    last_err: Exception = RuntimeError("Gemini API failed after 3 retries")
    for attempt in range(3):
        try:
            response = req.post(url, json=body, timeout=30)
            if response.status_code == 503:
                wait = 2 * (attempt + 1)
                print(f"Gemini 503 overload, retrying in {wait}s (attempt {attempt+1}/3)...")
                time.sleep(wait)
                last_err = RuntimeError(f"Gemini API error 503: {response.text[:200]}")
                continue
            if response.status_code != 200:
                raise RuntimeError(
                    f"Gemini API error {response.status_code}: {response.text[:300]}"
                )
            data = response.json()
            try:
                return data["candidates"][0]["content"]["parts"][0]["text"].strip()
            except (KeyError, IndexError) as exc:
                raise RuntimeError(f"Unexpected Gemini response format: {data}") from exc
        except RuntimeError:
            raise
        except Exception as exc:
            last_err = exc
            time.sleep(2)
            continue

    raise last_err



# ============================================================
# PURE PYTHON TEXT SPLITTER
# ============================================================

def split_text_into_chunks(
    text: str,
    chunk_size: int = 500,
    chunk_overlap: int = 100,
) -> list[str]:
    """Split text into overlapping chunks without requiring heavy dependencies."""
    if not text:
        return []

    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(current) + len(para) + 2 <= chunk_size:
            current = f"{current}\n\n{para}".strip()
        else:
            if current:
                chunks.append(current)
            if len(para) > chunk_size:
                words = para.split(" ")
                current = ""
                for word in words:
                    if len(current) + len(word) + 1 <= chunk_size:
                        current = f"{current} {word}".strip()
                    else:
                        if current:
                            chunks.append(current)
                        current = word
            else:
                current = para

    if current:
        chunks.append(current)

    # If overlap is requested and chunks are large enough, add overlap
    if chunk_overlap > 0 and len(chunks) > 1:
        overlapped_chunks = []
        for i, c in enumerate(chunks):
            if i > 0:
                prev_tail = chunks[i - 1][-chunk_overlap:]
                c = prev_tail + " " + c
            overlapped_chunks.append(c.strip())
        return overlapped_chunks

    return chunks


# ============================================================
# IN-MEMORY VECTOR STORE
# ============================================================

class InMemoryVectorStore:
    def __init__(self):
        self.chunks: list[str] = []
        self.embeddings: np.ndarray | None = None
        self.lock = threading.Lock()

    def clear(self) -> None:
        with self.lock:
            self.chunks = []
            self.embeddings = None

    def _embed_texts(self, texts: list[str]) -> np.ndarray:
        client = get_hf_client()
        raw = client.feature_extraction(texts, model=EMBEDDING_MODEL_ID)
        arr = np.asarray(raw, dtype=np.float32)

        # Handle 3D token embeddings (batch, seq, dim) by mean pooling
        if arr.ndim == 3:
            arr = np.mean(arr, axis=1)
        elif arr.ndim == 1:
            arr = arr.reshape(1, -1)

        # L2 normalize vectors for cosine similarity
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        arr = arr / np.maximum(norms, 1e-9)
        return arr

    def build_from_file(
        self,
        transcript_path: str | Path,
        chunk_size: int = 500,
        chunk_overlap: int = 100,
    ) -> None:
        transcript_path = Path(transcript_path)
        if not transcript_path.exists():
            raise FileNotFoundError(f"Transcript file not found: {transcript_path}")

        text = transcript_path.read_text(encoding="utf-8")
        clean_text = "\n".join(line.strip() for line in text.splitlines() if line.strip())

        if not clean_text:
            raise ValueError(f"Transcript file is empty: {transcript_path}")

        chunks = split_text_into_chunks(clean_text, chunk_size, chunk_overlap)
        if not chunks:
            raise ValueError(f"No chunks generated from transcript: {transcript_path}")

        with self.lock:
            self.chunks = chunks
            try:
                self.embeddings = self._embed_texts(chunks)
            except Exception as exc:
                print(f"HF embedding error: {exc}. Falling back to lexical keyword scoring.")
                self.embeddings = None

    def similarity_search(self, query: str, top_k: int = 4) -> list[str]:
        with self.lock:
            if not self.chunks:
                return []

            if self.embeddings is not None:
                try:
                    query_vec = self._embed_texts([query])[0]
                    scores = self.embeddings @ query_vec
                    top_indices = np.argsort(scores)[::-1][:top_k]
                    return [self.chunks[i] for i in top_indices]
                except Exception as exc:
                    print(f"Query embedding error: {exc}. Falling back to keyword search.")

            # Fallback: simple token overlap scoring
            q_tokens = set(re.findall(r"\w+", query.lower()))
            if not q_tokens:
                return self.chunks[:top_k]

            scores = []
            for chunk in self.chunks:
                c_tokens = set(re.findall(r"\w+", chunk.lower()))
                overlap = len(q_tokens & c_tokens)
                scores.append(overlap)

            top_indices = np.argsort(scores)[::-1][:top_k]
            return [self.chunks[i] for i in top_indices]


_vector_store = InMemoryVectorStore()


def clear_vector_store() -> None:
    """Discard cached transcript store so new transcript is used."""
    _vector_store.clear()


def build_vector_store_for_transcript(
    transcript_path: str | Path,
    chunk_size: int = 500,
    chunk_overlap: int = 100,
) -> InMemoryVectorStore:
    """Build fresh in-memory vector store for the given transcript file."""
    _vector_store.build_from_file(transcript_path, chunk_size, chunk_overlap)
    return _vector_store


def get_vector_store() -> InMemoryVectorStore:
    return _vector_store


# ============================================================
# TEXT HELPERS
# ============================================================

def split_into_sentences(text: str) -> list[str]:
    """Split English and Hindi transcript text into sentences."""
    sentences = re.split(r"(?<=[.!?।])\s+|(?<=[.!?।])(?=\S)", text)
    return [s.strip() for s in sentences if s.strip()]


def is_summary_question(question: str) -> bool:
    """Identify questions asking for a broad video overview."""
    normalized = re.sub(r"\s+", " ", question.lower()).strip()
    summary_phrases = [
        "tell me about this video",
        "tell me about the video",
        "what is this video about",
        "what is the video about",
        "summarize this video",
        "summarize the video",
        "summary of this video",
        "summary of the video",
        "give me an overview of this video",
        "give me an overview of the video",
        "main topic of this video",
        "main topic of the video",
    ]
    return any(phrase in normalized for phrase in summary_phrases)


# ============================================================
# LLM GENERATION VIA GOOGLE GEMINI REST API (free tier, no SDK)
# ============================================================

def generate_text(
    messages: list[dict[str, str]],
    max_new_tokens: int = 250,
    json_mode: bool = False,
) -> str:
    """Generate text using Google Gemini REST API (free tier, 1500 req/day)."""
    # Convert OpenAI-style messages to a single prompt for Gemini
    system_parts = []
    user_parts = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "system":
            system_parts.append(content)
        else:
            user_parts.append(content)

    full_prompt = ""
    if system_parts:
        full_prompt = "\n".join(system_parts) + "\n\n"
    full_prompt += "\n".join(user_parts)

    return _call_gemini_api(full_prompt, max_output_tokens=max_new_tokens, json_mode=json_mode)


# ============================================================
# QUERY REWRITING
# ============================================================

def rewrite_query(question: str) -> str:
    """Rewrite a question for retrieval without answering it."""
    messages = [
        {
            "role": "system",
            "content": (
                "Rewrite the user's question as one concise search query "
                "for finding relevant passages in a YouTube transcript. "
                "Preserve the actual topic and key terms. Do not answer. "
                "Return only the search query."
            ),
        },
        {"role": "user", "content": question},
    ]

    try:
        rewritten = generate_text(messages, max_new_tokens=40)
        if not rewritten or len(rewritten) > 250:
            return question
        return rewritten.strip().strip('"')
    except Exception:
        return question


def generate_multi_queries(question: str, num_queries: int = 3) -> list[str]:
    """Generate alternate retrieval queries."""
    messages = [
        {
            "role": "system",
            "content": (
                f"Generate {num_queries} short, distinct search queries "
                "to retrieve evidence from a YouTube transcript. "
                "Keep the user's original subject. Do not answer the "
                "question. Return one query per line, without explanations."
            ),
        },
        {"role": "user", "content": question},
    ]

    try:
        output = generate_text(messages, max_new_tokens=100)
        queries = []
        for line in output.splitlines():
            cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip().strip('"')
            if cleaned and cleaned not in queries:
                queries.append(cleaned)
        return queries[:num_queries]
    except Exception:
        return [question]


# ============================================================
# RETRIEVAL AND RERANKING
# ============================================================

def retrieve_candidates(queries: list[str]) -> list[str]:
    """Retrieve diverse candidate chunks for all queries."""
    store = get_vector_store()
    seen = set()
    candidates = []

    for query in queries:
        chunks = store.similarity_search(query, top_k=4)
        for chunk in chunks:
            chunk_clean = chunk.strip()
            if chunk_clean and chunk_clean not in seen:
                seen.add(chunk_clean)
                candidates.append(chunk_clean)

    return candidates


def rerank_documents(question: str, documents: list[str], top_k: int = TOP_K_CANDIDATES) -> list[tuple[str, float]]:
    """Score and rerank retrieved chunks."""
    if not documents:
        return []

    client = get_hf_client()
    try:
        scores = client.sentence_similarity(
            sentence=question,
            other_sentences=documents,
            model=EMBEDDING_MODEL_ID,
        )
        ranked = sorted(zip(documents, scores), key=lambda x: float(x[1]), reverse=True)
        return [(doc, float(score)) for doc, score in ranked[:top_k]]
    except Exception as exc:
        print(f"Reranking fallback to lexical score: {exc}")
        q_tokens = set(re.findall(r"\w+", question.lower()))
        scores = [len(q_tokens & set(re.findall(r"\w+", doc.lower()))) for doc in documents]
        ranked = sorted(zip(documents, scores), key=lambda x: x[1], reverse=True)
        return [(doc, float(score)) for doc, score in ranked[:top_k]]


# ============================================================
# CONTEXTUAL COMPRESSION
# ============================================================

def contextual_compression(
    question: str,
    ranked_documents: list[tuple[str, float]],
    max_sentences: int = MAX_COMPRESSION_SENTENCES,
    min_similarity: float = 0.20,
) -> tuple[str, list]:
    """Select sentences semantically related to the question."""
    if not ranked_documents:
        return "", []

    all_sentences = []
    for doc, _ in ranked_documents:
        all_sentences.extend(split_into_sentences(doc))

    if not all_sentences:
        return "", []

    client = get_hf_client()
    try:
        scores = client.sentence_similarity(
            sentence=question,
            other_sentences=all_sentences,
            model=EMBEDDING_MODEL_ID,
        )
        scored = [
            (sent, float(score))
            for sent, score in zip(all_sentences, scores)
            if float(score) >= min_similarity
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        selected = [sent for sent, _ in scored[:max_sentences]]
    except Exception:
        q_tokens = set(re.findall(r"\w+", question.lower()))
        scored = [
            (sent, len(q_tokens & set(re.findall(r"\w+", sent.lower()))))
            for sent in all_sentences
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        selected = [sent for sent, score in scored[:max_sentences] if score > 0]

    context = "\n".join(selected)
    return context, selected


# ============================================================
# ANSWER GENERATION
# ============================================================

def generate_answer(question: str, context: str) -> str:
    """Generate an answer grounded in the supplied transcript evidence."""
    if not context.strip():
        return "Not mentioned in the transcript."

    if is_summary_question(question):
        task = (
            "Give a clear, concise overview (3-5 sentences) of the actual topics discussed in the transcript evidence. "
            "Mention only topics, concepts, algorithms, examples, or steps supported by the evidence. "
            "Do not invent unsupported facts. "
            "Write in plain sentences — do NOT use markdown, asterisks, bullet points, or any special formatting."
        )
    else:
        task = (
            "Answer the question clearly using only the transcript evidence. "
            "Write 2-4 plain sentences. "
            "Do not use outside knowledge or guess. "
            "Do NOT use markdown, asterisks, bullet points, or any special formatting. "
            "If the answer is not in the evidence, reply exactly: Not mentioned in the transcript."
        )

    messages = [
        {
            "role": "system",
            "content": (
                "You are a YouTube transcript question-answering assistant. "
                "The transcript may be in Hindi while the question is in English — "
                "understand the evidence across languages and reply in English. "
                "CRITICAL: Write only plain text. No markdown. No asterisks. No bullet points. No bold.\n\n"
                f"INSTRUCTIONS:\n{task}\n\n"
                f"TRANSCRIPT EVIDENCE:\n{context}"
            ),
        },
        {"role": "user", "content": question},
    ]

    answer = generate_text(messages, max_new_tokens=450)
    return answer if answer else "Not mentioned in the transcript."



# ============================================================
# PUBLIC RAG FUNCTION
# ============================================================

def ask_rag(
    question: str,
    top_k: int = TOP_K_CANDIDATES,
    max_compression_sentences: int = MAX_COMPRESSION_SENTENCES,
) -> dict:
    """Run retrieval, reranking, compression and generation."""
    question = question.strip()
    if not question:
        raise ValueError("Question cannot be empty.")

    summary_question = is_summary_question(question)

    if summary_question:
        queries = [
            question,
            "main topics and concepts discussed in the video",
            "important technical concepts explained by the speaker",
        ]
    else:
        rewritten = rewrite_query(question)
        alternatives = generate_multi_queries(question, num_queries=2)
        queries = [question, rewritten] + alternatives

    # Deduplicate queries
    queries = list(dict.fromkeys(q.strip() for q in queries if q and q.strip()))

    # 1. Retrieve
    candidate_documents = retrieve_candidates(queries)
    if not candidate_documents:
        return {
            "answer": "Not mentioned in the transcript.",
            "sources": [],
            "scores": [],
        }

    # 2. Rerank
    ranked_documents = rerank_documents(
        question,
        candidate_documents,
        top_k=max(top_k, MAX_SUMMARY_DOCUMENTS) if summary_question else top_k,
    )
    if not ranked_documents:
        return {
            "answer": "Not mentioned in the transcript.",
            "sources": [],
            "scores": [],
        }

    # 3. Contextual Compression
    if summary_question:
        selected_documents = ranked_documents[:MAX_SUMMARY_DOCUMENTS]
        context = "\n\n".join(doc for doc, _ in selected_documents)
    else:
        context, _ = contextual_compression(
            question=question,
            ranked_documents=ranked_documents,
            max_sentences=max_compression_sentences,
            min_similarity=0.20,
        )
        if not context.strip():
            context = "\n\n".join(doc for doc, _ in ranked_documents[:2])

    # 4. Generate Answer
    answer = generate_answer(question, context)

    return {
        "answer": answer,
        "sources": [doc[:700] for doc, _ in ranked_documents],
        "scores": [float(score) for _, score in ranked_documents],
    }
