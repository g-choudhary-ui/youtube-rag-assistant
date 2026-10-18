# YouTube RAG Assistant

A Chrome extension + FastAPI backend that answers questions and generates structured summaries based on the transcript of the currently opened YouTube video. Powered by **Google Gemini 3.8 Flash** with multilingual semantic retrieval.

## Live Deployment
- **API URL**: [https://youtube-rag-assistant-1-hjvt.onrender.com](https://youtube-rag-assistant-1-hjvt.onrender.com)
- **API Docs (Swagger UI)**: [https://youtube-rag-assistant-1-hjvt.onrender.com/docs](https://youtube-rag-assistant-1-hjvt.onrender.com/docs)

## Features
- **Accurate Q&A**: Answers questions strictly grounded in the video's transcript.
- **Powered by Gemini 3.8 Flash**: Fast inference and high accuracy using Google's latest lightweight multimodal model.
- **Smart Summarization**: One-click structured breakdown including overview, key takeaways, core concepts, and timestamped highlights.
- **Time-Range Filtering**: Focus on a specific segment (e.g. from 05:00 to 12:30).
- **Dual Transcript Fetching**: Extension extracts captions directly from YouTube page DOM / InnerTube API, with fallback on the backend.
- **Lightweight & Free Cloud Hosting**: Optimized to run effortlessly on Render's Free tier (< 50MB RAM).
- **Chrome Extension UI**: Clean popup with real-time video transcript syncing, Markdown answer rendering, and chat history.

## Project Structure
- `backend/` — FastAPI backend and RAG engine
- `chrome-extension/` — Chrome extension popup UI and logic
- `render.yaml` — Render deployment blueprint
- `requirements.txt` — Python dependencies

## Deployment on Render (100% Free)

1. **Get your free Gemini API Key**:
   - Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
   - Click **Create API key** and copy your key.

2. **Deploy on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com/) and click **New > Web Service**.
   - Connect this GitHub repository: `https://github.com/g-choudhary-ui/youtube-rag-assistant`.
   - Settings:
     - **Runtime**: `Python`
     - **Root Directory**: `backend`
     - **Build Command**: `pip install -r requirements.txt`
     - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port 10000`
   - In the **Environment Variables** section, add:
     - **`GEMINI_API_KEY`**: your Gemini API key from Google AI Studio
     - **`PYTHON_VERSION`**: `3.11.9`
   - Click **Deploy Web Service**.

3. **Connect the Chrome Extension**:
   - The default URL is pre-configured to `https://youtube-rag-assistant-1-hjvt.onrender.com`.
   - Or paste your own Render URL into the **Backend URL** input field at the top of the popup.
   - Open any YouTube video with captions and start chatting!

## Local Development Setup

1. Open a terminal in `backend/`:
   ```powershell
   cd backend
   pip install -r requirements.txt
   ```
2. Create a `.env` file in `backend/`:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
3. Start the server:
   ```powershell
   uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
   ```
4. Load the Chrome extension:
   - Go to `chrome://extensions` in Google Chrome.
   - Enable **Developer mode** (top right).
   - Click **Load unpacked** and select the `chrome-extension/` folder.

## License
MIT
