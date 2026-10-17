
import json
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from youtube_transcript_api import YouTubeTranscriptApi

from app.schemas.chat import ChatRequest, ChatResponse, SummaryRequest, SummaryResponse
from app.services.rag_engine import ask_rag, build_vector_store_for_transcript, clear_vector_store, generate_text

router = APIRouter(prefix="/api", tags=["RAG Chat"])


def _fetch_transcript(video_id: str):
    api = YouTubeTranscriptApi()

    try:
        transcript_list = api.list(video_id)
        try:
            return transcript_list.find_transcript(["en", "en-US", "en-GB"]).fetch()
        except Exception:
            try:
                return transcript_list.find_transcript(["hi"]).fetch()
            except Exception:
                for t in transcript_list:
                    return t.fetch()
        raise RuntimeError("No transcript available for this video.")
    except Exception as exc:
        raise RuntimeError(f"Could not fetch transcript for video {video_id}: {exc}") from exc


def _save_video_transcript(video_id: str) -> Path:
    transcript_path = Path(__file__).resolve().parents[2] / "transcript.txt"
    transcript = _fetch_transcript(video_id)
    transcript_text = " ".join(snippet.text for snippet in transcript)
    transcript_path.write_text(transcript_text, encoding="utf-8")
    return transcript_path


def _format_timestamp(seconds: float) -> str:
    total_seconds = max(int(float(seconds)), 0)
    minutes, secs = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _filter_transcript_by_range(transcript, start_time: float | None = None, end_time: float | None = None):
    if start_time is None and end_time is None:
        return transcript

    filtered = []
    for snippet in transcript:
        snippet_start = float(getattr(snippet, "start", 0) or 0)
        snippet_end = snippet_start + float(getattr(snippet, "duration", 0) or 0)

        if start_time is not None and snippet_end < float(start_time):
            continue
        if end_time is not None and snippet_start > float(end_time):
            continue
        filtered.append(snippet)

    return filtered


def _write_section_transcript(transcript, start_time: float | None = None, end_time: float | None = None) -> Path:
    selected = _filter_transcript_by_range(transcript, start_time, end_time)
    if not selected:
        raise ValueError("No transcript content found in the selected time range.")

    section_text = " ".join(snippet.text for snippet in selected)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as temp_file:
        temp_file.write(section_text)
        temp_path = Path(temp_file.name)
    return temp_path


def _parse_summary_payload(raw_text: str) -> dict:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        payload = {
            "overview": cleaned,
            "key_takeaways": [],
            "important_concepts": [],
            "detailed_summary": cleaned,
            "timestamps": [],
        }

    if not isinstance(payload, dict):
        payload = {
            "overview": str(cleaned),
            "key_takeaways": [],
            "important_concepts": [],
            "detailed_summary": str(cleaned),
            "timestamps": [],
        }

    payload.setdefault("overview", "")
    payload.setdefault("key_takeaways", [])
    payload.setdefault("important_concepts", [])
    payload.setdefault("detailed_summary", payload.get("overview", ""))
    payload.setdefault("timestamps", [])

    return payload


@router.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    try:
        if request.video_id:
            transcript = _fetch_transcript(request.video_id)
            transcript_path = _save_video_transcript(request.video_id)

            if request.start_time is not None or request.end_time is not None:
                section_path = _write_section_transcript(transcript, request.start_time, request.end_time)
                transcript_path = section_path

            clear_vector_store()
            build_vector_store_for_transcript(transcript_path)
        result = ask_rag(request.question)
        return ChatResponse(**result)

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        import logging
        logging.exception("RAG processing failed")
        err_msg = str(exc)
        if "No transcript" in err_msg or "Could not retrieve a transcript" in err_msg:
            detail = "This YouTube video has no captions/subtitles available. Please try a video with CC/subtitles enabled."
        elif "HF_TOKEN" in err_msg or "401" in err_msg or "Unauthorized" in err_msg:
            detail = "Hugging Face API token is missing or invalid. Please add HF_TOKEN in your Render Environment tab."
        else:
            detail = f"RAG processing failed: {err_msg}"
        raise HTTPException(
            status_code=500,
            detail=detail,
        ) from exc


@router.post("/summary", response_model=SummaryResponse)
def summarize_video(request: SummaryRequest):
    try:
        transcript = _fetch_transcript(request.video_id)

        if not transcript:
            raise ValueError("No transcript found for this video.")

        evidence = "\n\n".join(
            f"[{_format_timestamp(getattr(snippet, 'start', 0))}] {snippet.text}"
            for snippet in transcript[:40]
        )

        system_prompt = (
            "You are a concise YouTube transcript summarizer. "
            "Return valid JSON only with the following keys: "
            "overview, key_takeaways, important_concepts, detailed_summary, timestamps. "
            "overview must be a 1-3 sentence summary of the video. "
            "key_takeaways and important_concepts must be arrays of short strings. "
            "detailed_summary should be a short paragraph summarizing the flow of the lesson. "
            "timestamps must be a list of objects with 'time' (mm:ss) and 'label' (short summary). "
            "Use only the transcript evidence and include timestamps when they are available."
        )
        user_prompt = (
            "Summarize this transcript. Keep it grounded in the evidence and mention the main topic, "
            "the main ideas, and any practical takeaway.\n\nTRANSCRIPT EVIDENCE:\n"
            f"{evidence}"
        )

        answer = generate_text(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_new_tokens=350,
        )
        payload = _parse_summary_payload(answer)

        timestamps = payload.get("timestamps", [])
        if not isinstance(timestamps, list):
            timestamps = []
        cleaned_timestamps = []
        for item in timestamps[:8]:
            if isinstance(item, dict):
                cleaned_timestamps.append({
                    "time": str(item.get("time", "00:00")),
                    "label": str(item.get("label", "Key point")),
                })

        transcript_entries = []
        for snippet in transcript[:8]:
            start = getattr(snippet, "start", 0) or 0
            text = getattr(snippet, "text", "").strip()
            if text:
                transcript_entries.append({
                    "time": _format_timestamp(start),
                    "label": text[:80],
                })

        if cleaned_timestamps:
            timestamps_payload = cleaned_timestamps
        else:
            timestamps_payload = transcript_entries

        return SummaryResponse(
            overview=str(payload.get("overview") or "This video covers the main ideas explained in the transcript."),
            key_takeaways=[str(item) for item in payload.get("key_takeaways", [])[:5]],
            important_concepts=[str(item) for item in payload.get("important_concepts", [])[:5]],
            detailed_summary=str(payload.get("detailed_summary") or payload.get("overview") or ""),
            timestamps=timestamps_payload,
        )

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        import logging
        logging.exception("Summary generation failed")
        err_msg = str(exc)
        if "No transcript" in err_msg or "Could not retrieve a transcript" in err_msg:
            detail = "This YouTube video has no captions/subtitles available. Please try a video with CC/subtitles enabled."
        elif "HF_TOKEN" in err_msg or "401" in err_msg or "Unauthorized" in err_msg:
            detail = "Hugging Face API token is missing or invalid. Please add HF_TOKEN in your Render Environment tab."
        else:
            detail = f"Summary generation failed: {err_msg}"
        raise HTTPException(
            status_code=500,
            detail=detail,
        ) from exc
