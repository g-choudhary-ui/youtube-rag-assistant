from __future__ import annotations

import argparse
from pathlib import Path

from youtube_transcript_api import YouTubeTranscriptApi
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.services.rag_engine import ask_rag


BASE_DIR = Path(__file__).resolve().parent
TRANSCRIPT_PATH = BASE_DIR / "transcript.txt"
FAISS_DIR = BASE_DIR / "data" / "faiss_index"
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def fetch_transcript(video_id: str) -> str:
    api = YouTubeTranscriptApi()

    try:
        try:
            transcript = api.fetch(video_id, languages=["en"])
        except Exception:
            try:
                transcript = api.fetch(video_id, languages=["hi"])
            except Exception:
                transcript = api.fetch(video_id)
    except Exception as exc:
        raise RuntimeError(f"Could not fetch transcript for video {video_id}: {exc}") from exc

    transcript_text = " ".join(snippet.text for snippet in transcript)
    TRANSCRIPT_PATH.write_text(transcript_text, encoding="utf-8")
    return transcript_text


def rebuild_faiss(transcript_path: Path, output_dir: Path, chunk_size: int = 500, chunk_overlap: int = 100):
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
        raise ValueError("No chunks generated from transcript.")

    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL,
        encode_kwargs={"normalize_embeddings": True},
    )

    if output_dir.exists():
        for child in output_dir.iterdir():
            if child.is_file() or child.is_symlink():
                child.unlink()
            else:
                for nested in sorted(child.rglob("*"), reverse=True):
                    if nested.is_file() or nested.is_symlink():
                        nested.unlink()
                    elif nested.is_dir():
                        nested.rmdir()
                child.rmdir()
    output_dir.mkdir(parents=True, exist_ok=True)

    vector_store = FAISS.from_texts(chunks, embeddings)
    vector_store.save_local(str(output_dir))
    print(f"FAISS rebuilt at: {output_dir}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id", default="J5_-l7WIO_w")
    parser.add_argument("--question", default="What is the purpose of the RAG pipeline?")
    args = parser.parse_args()

    print("Fetching transcript...")
    fetch_transcript(args.video_id)

    print("Rebuilding FAISS index...")
    rebuild_faiss(TRANSCRIPT_PATH, FAISS_DIR)

    print("Running RAG query...")
    result = ask_rag(args.question)
    print(result)


if __name__ == "__main__":
    main()
