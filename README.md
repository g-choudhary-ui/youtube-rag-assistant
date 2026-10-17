# YouTube RAG Assistant

A Chrome extension + FastAPI backend that answers questions and generates structured summaries based on the transcript of the currently opened YouTube video. Powered by **Hugging Face Qwen 2.5 (7B-Instruct)** and multilingual semantic embeddings.

## Features
- **Accurate Q&A**: Answers questions strictly grounded in the video's transcript.
- **Powered by Qwen**: Uses `Qwen/Qwen2.5-7B-Instruct` via Hugging Face for high accuracy and fast responses.
- **Smart Summarization**: One-click overview, key takeaways, core concepts, and timestamped highlights.
- **Time-Range Filtering**: Focus on a specific segment (e.g. from 05:00 to 12:30).
- **Lightweight & Free Cloud Hosting**: Optimized to run effortlessly on Render's Free tier (< 50MB RAM).
- **Chrome Extension UI**: Clean popup with real-time video transcript syncing and chat history.

## Project Structure
- `backend/` — FastAPI backend and RAG engine
- `chrome-extension/` — Chrome extension popup UI and logic
- `render.yaml` — Render deployment blueprint
- `requirements.txt` — Python dependencies

## Deployment on Render (100% Free)

1. **Get your free Hugging Face token**:
   - Go to [Hugging Face Settings > Tokens](https://huggingface.co/settings/tokens).
   - Click **Create new token**, select type **Read**, and copy the token (`hf_...`).

2. **Deploy on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com/) and click **New > Web Service**.
   - Connect this GitHub repository: `https://github.com/g-choudhary-ui/youtube-rag-assistant`.
   - Settings:
     - **Runtime**: `Python`
     - **Root Directory**: `backend`
     - **Build Command**: `pip install -r requirements.txt`
     - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port 10000`
   - In the **Environment Variables** section, add:
     - **`HF_TOKEN`**: your Hugging Face token (`hf_...`)
     - **`PYTHON_VERSION`**: `3.11.9`
   - Click **Deploy Web Service**.

3. **Connect the Chrome Extension**:
   - Once deployed, copy your Render URL (e.g., `https://youtube-rag-api.onrender.com`).
   - Open the Chrome extension popup.
   - Paste the Render URL into the **Backend URL** input field at the top.
   - Open any YouTube video with captions and start chatting!

## Local Development Setup

1. Open a terminal in `backend/`:
   ```powershell
   cd backend
   pip install -r requirements.txt
   ```
2. Create a `.env` file in `backend/`:
   ```env
   HF_TOKEN=your_hugging_face_token_here
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
