
from __future__ import annotations

import re
import threading
from pathlib import Path

import numpy as np
import torch
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import CrossEncoder
from transformers import AutoModelForCausalLM, AutoTokenizer


# ============================================================
# PATHS AND CONFIGURATION
# ============================================================

# backend/app/services/rag_engine.py -> backend/
BASE_DIR = Path(__file__).resolve().parents[2]

TRANSCRIPT_PATH = BASE_DIR / "transcript.txt"
VECTOR_STORE_PATH = BASE_DIR / "data" / "faiss_index"

EMBEDDING_MODEL = (
    "sentence-transformers/"
    "paraphrase-multilingual-MiniLM-L12-v2"
)

LLM_MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"

# Multilingual reranker: better suited to Hindi source text
# and English questions than an English-only reranker.
RERANKER_MODEL_ID = "BAAI/bge-reranker-v2-m3"

TOP_K_CANDIDATES = 4
MAX_SUMMARY_DOCUMENTS = 4
MAX_COMPRESSION_SENTENCES = 10


# ============================================================
# EMBEDDINGS
# ============================================================

embeddings = HuggingFaceEmbeddings(
    model_name=EMBEDDING_MODEL,
    encode_kwargs={"normalize_embeddings": True},
)


# ============================================================
# LAZY-LOADED MODELS
# ============================================================

tokenizer = None
model = None
reranker = None

model_lock = threading.Lock()
reranker_lock = threading.Lock()


def load_llm() -> None:
    """Load Qwen only when the first request needs it."""
    global tokenizer, model

    with model_lock:
        if model is not None:
            return

        print("Loading Qwen model...")

        tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL_ID)

        model = AutoModelForCausalLM.from_pretrained(
            LLM_MODEL_ID,
            torch_dtype=torch.float32,
        )

        model.eval()

        print("Qwen model loaded.")


def get_reranker():
    """Load the multilingual reranker only when needed."""
    global reranker

    with reranker_lock:
        if reranker is None:
            print("Loading multilingual reranker...")
            reranker = CrossEncoder(RERANKER_MODEL_ID)
            print("Reranker loaded.")

    return reranker


# ============================================================
# FAISS VECTOR STORE
# ============================================================

_vector_store = None
_vector_store_lock = threading.Lock()


def clear_vector_store() -> None:
    """Discard the cached FAISS store so a newly fetched transcript is used."""
    global _vector_store

    with _vector_store_lock:
        _vector_store = None


def build_vector_store_for_transcript(
    transcript_path: str | Path,
    output_dir: str | Path = VECTOR_STORE_PATH,
    chunk_size: int = 500,
    chunk_overlap: int = 100,
) -> FAISS:
    """Build a fresh FAISS index from a transcript and cache it in memory."""
    global _vector_store

    transcript_path = Path(transcript_path)
    output_dir = Path(output_dir)

    if not transcript_path.exists():
        raise FileNotFoundError(f"Transcript file not found: {transcript_path}")

    text = transcript_path.read_text(encoding="utf-8")
    clean_text = "\n".join(line.strip() for line in text.splitlines() if line.strip())

    if not clean_text:
        raise ValueError(f"Transcript file is empty: {transcript_path}")

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", " ", ""],
    )
    chunks = splitter.split_text(clean_text)

    if not chunks:
        raise ValueError(f"No chunks generated from transcript: {transcript_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    for child in output_dir.iterdir():
        if child.is_file() or child.is_symlink():
            child.unlink()
        elif child.is_dir():
            for nested in sorted(child.rglob("*"), reverse=True):
                if nested.is_file() or nested.is_symlink():
                    nested.unlink()
                elif nested.is_dir():
                    nested.rmdir()
            child.rmdir()

    vector_store = FAISS.from_texts(chunks, embeddings)
    vector_store.save_local(str(output_dir))

    with _vector_store_lock:
        _vector_store = vector_store

    return _vector_store


def get_vector_store() -> FAISS:
    """Load the existing FAISS index."""
    global _vector_store

    with _vector_store_lock:
        if _vector_store is not None:
            return _vector_store

        index_file = VECTOR_STORE_PATH / "index.faiss"
        metadata_file = VECTOR_STORE_PATH / "index.pkl"

        if not index_file.is_file() or not metadata_file.is_file():
            raise FileNotFoundError(
                f"FAISS index files are missing in {VECTOR_STORE_PATH}. "
                "Run rebuild_faiss.py before starting the API."
            )

        print("Loading FAISS index...")

        _vector_store = FAISS.load_local(
            str(VECTOR_STORE_PATH),
            embeddings,
            allow_dangerous_deserialization=True,
        )

        print("FAISS index loaded and cached.")

        return _vector_store


# ============================================================
# TEXT HELPERS
# ============================================================

def split_into_sentences(text: str) -> list[str]:
    """Split English and Hindi transcript text into sentences."""
    sentences = re.split(
        r"(?<=[.!?।])\s+|(?<=[.!?।])(?=\S)",
        text,
    )

    return [
        sentence.strip()
        for sentence in sentences
        if sentence.strip()
    ]


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
# QWEN GENERATION
# ============================================================

def generate_text(
    messages: list[dict[str, str]],
    max_new_tokens: int = 120,
) -> str:
    """Generate text with Qwen using its native chat template."""
    load_llm()

    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )

    inputs = tokenizer(
        prompt,
        return_tensors="pt",
        truncation=True,
        max_length=4096,
    )

    with model_lock:
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                repetition_penalty=1.05,
                pad_token_id=tokenizer.eos_token_id,
            )

    new_tokens = outputs[0][inputs["input_ids"].shape[1]:]

    return tokenizer.decode(
        new_tokens,
        skip_special_tokens=True,
    ).strip()


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
        {
            "role": "user",
            "content": question,
        },
    ]

    rewritten = generate_text(messages, max_new_tokens=40)

    # Avoid replacing a useful original question with a bad rewrite.
    if not rewritten or len(rewritten) > 250:
        return question

    return rewritten.strip().strip('"')


def generate_multi_queries(
    question: str,
    num_queries: int = 3,
) -> list[str]:
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
        {
            "role": "user",
            "content": question,
        },
    ]

    output = generate_text(messages, max_new_tokens=100)

    queries = []

    for line in output.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        cleaned = cleaned.strip('"').strip()

        if cleaned and cleaned not in queries:
            queries.append(cleaned)

    return queries[:num_queries]


# ============================================================
# RETRIEVAL
# ============================================================

def retrieve_candidates(queries: list[str]) -> list:
    """Retrieve diverse chunks with MMR and remove duplicates."""
    store = get_vector_store()

    retriever = store.as_retriever(
        search_type="mmr",
        search_kwargs={
            "k": 4,
            "fetch_k": 15,
            "lambda_mult": 0.5,
        },
    )

    unique_documents = {}

    for query in queries:
        if not query.strip():
            continue

        try:
            documents = retriever.invoke(query)
        except Exception as exc:
            print(f"Retrieval failed for query {query!r}: {exc}")
            continue

        for document in documents:
            content = document.page_content.strip()

            if content:
                unique_documents.setdefault(content, document)

    return list(unique_documents.values())


def rerank_documents(
    question: str,
    documents: list,
    top_k: int = TOP_K_CANDIDATES,
) -> list:
    """Rerank retrieved passages by relevance to the original question."""
    if not documents:
        return []

    reranker_model = get_reranker()

    pairs = [
        [question, document.page_content]
        for document in documents
    ]

    scores = reranker_model.predict(
        pairs,
        show_progress_bar=False,
    )

    ranked = sorted(
        zip(documents, scores),
        key=lambda item: float(item[1]),
        reverse=True,
    )

    return [
        (document, float(score))
        for document, score in ranked[:top_k]
    ]


# ============================================================
# CONTEXTUAL COMPRESSION
# ============================================================

def contextual_compression(
    question: str,
    ranked_documents: list,
    max_sentences: int = MAX_COMPRESSION_SENTENCES,
    min_similarity: float = 0.20,
) -> tuple[str, list]:
    """
    Select sentences semantically related to the question.

    Similarity scores are cosine similarities between normalized
    multilingual embeddings. They are not reranker scores.
    """
    if not ranked_documents:
        return "", []

    question_vector = np.asarray(
        embeddings.embed_query(question),
        dtype=np.float32,
    )

    question_norm = np.linalg.norm(question_vector)

    if question_norm == 0:
        return "", []

    question_vector /= question_norm

    candidates = []

    for document_rank, (document, reranker_score) in enumerate(
        ranked_documents
    ):
        sentences = split_into_sentences(document.page_content)

        if not sentences:
            continue

        sentence_vectors = np.asarray(
            embeddings.embed_documents(sentences),
            dtype=np.float32,
        )

        norms = np.linalg.norm(
            sentence_vectors,
            axis=1,
            keepdims=True,
        )

        sentence_vectors /= np.maximum(norms, 1e-10)

        similarities = sentence_vectors @ question_vector

        for sentence_index, (sentence, similarity) in enumerate(
            zip(sentences, similarities)
        ):
            candidates.append(
                {
                    "sentence": sentence,
                    "similarity": float(similarity),
                    "document_rank": document_rank,
                    "sentence_index": sentence_index,
                }
            )

    # Keep the strongest sentence matches.
    selected = [
        item
        for item in candidates
        if item["similarity"] >= min_similarity
    ]

    selected.sort(
        key=lambda item: item["similarity"],
        reverse=True,
    )

    selected = selected[:max_sentences]

    # Restore transcript order.
    selected.sort(
        key=lambda item: (
            item["document_rank"],
            item["sentence_index"],
        )
    )

    context = "\n".join(
        item["sentence"]
        for item in selected
    )

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
            "Give a concise overview of the actual topics discussed "
            "in the transcript evidence. Mention only topics, concepts, "
            "algorithms, examples, or steps supported by the evidence. "
            "Do not invent a business topic or any other unsupported topic. "
            "If the evidence does not establish the video's subject, reply: "
            "Not enough relevant transcript evidence to summarize this video."
        )
    else:
        task = (
            "Answer the question using only the transcript evidence. "
            "Do not use outside knowledge or guess. If the answer is not "
            "supported by the evidence, reply exactly: "
            "Not mentioned in the transcript."
        )

    messages = [
        {
            "role": "system",
            "content": (
                "You are a strict YouTube transcript question-answering "
                "assistant. The transcript may be in Hindi while the "
                "question is in English. Understand the evidence across "
                "languages, but do not introduce unsupported facts.\n\n"
                f"INSTRUCTIONS:\n{task}\n\n"
                f"TRANSCRIPT EVIDENCE:\n{context}"
            ),
        },
        {
            "role": "user",
            "content": question,
        },
    ]

    answer = generate_text(messages, max_new_tokens=160)

    if not answer:
        return "Not mentioned in the transcript."

    return answer


# ============================================================
# PUBLIC RAG FUNCTION
# ============================================================

def ask_rag(
    question: str,
    top_k: int = TOP_K_CANDIDATES,
    max_compression_sentences: int = MAX_COMPRESSION_SENTENCES,
) -> dict:
    """Run query expansion, retrieval, reranking, compression and generation."""
    question = question.strip()

    if not question:
        raise ValueError("Question cannot be empty.")

    print("\n" + "=" * 60)
    print("QUESTION:", question)

    summary_question = is_summary_question(question)

    # Broad summary questions need diverse transcript evidence.
    if summary_question:
        queries = [
            question,
            "main topics and concepts discussed in the video",
            "algorithms, data structures, programming examples and explanations",
            "important technical concepts explained by the speaker",
        ]
    else:
        rewritten = rewrite_query(question)
        alternatives = generate_multi_queries(question, num_queries=3)

        queries = [question, rewritten] + alternatives

    # Remove duplicate queries.
    queries = list(
        dict.fromkeys(
            query.strip()
            for query in queries
            if query and query.strip()
        )
    )

    print("\nRETRIEVAL QUERIES:")
    for query in queries:
        print(" -", query)

    # 1. Retrieve.
    candidate_documents = retrieve_candidates(queries)

    print(f"\nRETRIEVED {len(candidate_documents)} CANDIDATES")

    if not candidate_documents:
        return {
            "answer": "Not mentioned in the transcript.",
            "sources": [],
            "scores": [],
        }

    # 2. Rerank.
    ranked_documents = rerank_documents(
        question,
        candidate_documents,
        top_k=max(top_k, MAX_SUMMARY_DOCUMENTS)
        if summary_question
        else top_k,
    )

    print(f"\nRERANKED TO {len(ranked_documents)} DOCUMENTS")

    for index, (document, score) in enumerate(ranked_documents, start=1):
        print(f"\nDOCUMENT {index} | Reranker score: {score:.4f}")
        print(document.page_content[:350].replace("\n", " "))

    if not ranked_documents:
        return {
            "answer": "Not mentioned in the transcript.",
            "sources": [],
            "scores": [],
        }

    # 3. Prepare context.
    if summary_question:
        # Avoid sentence compression for a broad overview.
        # Preserve multiple ranked passages so the model can identify
        # the video's subject from the actual evidence.
        selected_documents = ranked_documents[:MAX_SUMMARY_DOCUMENTS]

        context = "\n\n".join(
            document.page_content
            for document, _ in selected_documents
        )
    else:
        context, selected_sentences = contextual_compression(
            question=question,
            ranked_documents=ranked_documents,
            max_sentences=max_compression_sentences,
            min_similarity=0.20,
        )

        print(
            "\nCOMPRESSED TO",
            len(selected_sentences),
            "SENTENCES",
        )

        # If compression is too aggressive, fall back to full passages.
        if not context.strip():
            context = "\n\n".join(
                document.page_content
                for document, _ in ranked_documents[:2]
            )

    print("\nCONTEXT SENT TO QWEN:\n")
    print(context[:3000])

    # 4. Generate.
    answer = generate_answer(question, context)

    print("\nFINAL ANSWER:", answer)

    return {
        "answer": answer,
        "sources": [
            document.page_content[:700]
            for document, _ in ranked_documents
        ],
        "scores": [
            float(score)
            for _, score in ranked_documents
        ],
    }
