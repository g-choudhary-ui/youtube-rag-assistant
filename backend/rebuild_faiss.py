from __future__ import annotations

import argparse
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter


DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "data" / "faiss_index"
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def build_index(transcript_path: str | Path, output_dir: str | Path, chunk_size: int = 500, chunk_overlap: int = 100) -> Path:
    transcript_path = Path(transcript_path)
    output_path = Path(output_dir)

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

    embeddings = HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL,
        encode_kwargs={"normalize_embeddings": True},
    )

    # delete stale index first so bad files cannot be reused
    if output_path.exists():
        for child in output_path.iterdir():
            if child.is_file() or child.is_symlink():
                child.unlink()
            else:
                for nested in sorted(child.rglob("*"), reverse=True):
                    if nested.is_file() or nested.is_symlink():
                        nested.unlink()
                    elif nested.is_dir():
                        nested.rmdir()
                child.rmdir()
    output_path.mkdir(parents=True, exist_ok=True)

    vector_store = FAISS.from_texts(chunks, embeddings)
    vector_store.save_local(str(output_path))
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Rebuild the FAISS vector store from a transcript text file.")
    parser.add_argument("--transcript", required=True, help="Path to the transcript text file in UTF-8")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory to save the FAISS index")
    parser.add_argument("--chunk-size", type=int, default=500, help="Text chunk size in characters")
    parser.add_argument("--chunk-overlap", type=int, default=100, help="Overlap between chunks")
    args = parser.parse_args()

    output_dir = build_index(args.transcript, args.output_dir, args.chunk_size, args.chunk_overlap)
    print(f"FAISS index rebuilt successfully at: {output_dir}")


if __name__ == "__main__":
    main()
