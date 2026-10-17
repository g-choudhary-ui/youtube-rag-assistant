# YouTube RAG Assistant

A local Chrome extension + FastAPI backend that answers questions based on the transcript of the currently opened YouTube video.

## Features
- Ask questions about the current YouTube video transcript
- Per-video chat history stored locally in the browser
- Saved notes for important concepts and explanations
- One-click summary generation
- Optional time-range filtering for transcript sections
- Relevance-based retrieval using FAISS + embeddings
- Local RAG pipeline with transcript-aware answer generation

## Project structure
- `backend/` — FastAPI backend and RAG logic
- `chrome-extension/` — Chrome extension popup UI and logic
- `render.yaml` — Render deployment config
- `backend/requirements.txt` — Python dependencies

## Local setup

1. Open a terminal in the project root.
2. Start the backend:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

3. Load the Chrome extension:
- Open `chrome://extensions`
- Enable Developer mode
- Click Load unpacked
- Select the `chrome-extension` folder

4. Open a YouTube video and click the extension icon.
5. Ask a question or use the one-click summary feature.

## Extension configuration
The popup includes a backend URL field. By default it is:

```text
http://127.0.0.1:8000
```

Change this to your deployed backend URL when using a hosted version.

## Deployment
This project is ready for Render deployment using the included `render.yaml` file.

## Notes
- The extension works only on real YouTube video pages with captions/transcripts available.
- For long videos, use the optional start/end timestamp filter to narrow the transcript section.

## License
MIT
