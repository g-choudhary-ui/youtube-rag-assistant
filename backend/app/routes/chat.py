
import json
import logging
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from youtube_transcript_api import YouTubeTranscriptApi

from app.schemas.chat import ChatRequest, ChatResponse, SummaryRequest, SummaryResponse
from app.services.rag_engine import ask_rag, build_vector_store_for_transcript, clear_vector_store, generate_text

logger = logging.getLogger(__name__)


def _get_snippet_attr(snippet, attr: str, default=None):
    """Read an attribute from either a dict or an object snippet."""
    if isinstance(snippet, dict):
        return snippet.get(attr, default)
    return getattr(snippet, attr, default)

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
    transcript_text = " ".join(_get_snippet_attr(s, "text", "") for s in transcript)
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
        snippet_start = float(_get_snippet_attr(snippet, "start", 0) or 0)
        snippet_end = snippet_start + float(_get_snippet_attr(snippet, "duration", 0) or 0)

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

    section_text = " ".join(_get_snippet_attr(s, "text", "") for s in selected if _get_snippet_attr(s, "text", ""))
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as temp_file:
        temp_file.write(section_text)
        temp_path = Path(temp_file.name)
    return temp_path


def _parse_summary_payload(raw_text: str) -> dict:
    cleaned = raw_text.strip()
    # Strip markdown code fences
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned.strip())

    payload: dict = {}
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        # JSON is malformed/truncated — extract fields with regex
        def _extract_str(key: str, text: str) -> str:
            m = re.search(rf'"{key}"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
            return m.group(1) if m else ""

        def _extract_list(key: str, text: str) -> list[str]:
            m = re.search(rf'"{key}"\s*:\s*\[([^\]]*)', text)
            if not m:
                return []
            items = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
            return items

        overview = _extract_str("overview", cleaned)
        detailed = _extract_str("detailed_summary", cleaned) or overview
        takeaways = _extract_list("key_takeaways", cleaned)
        concepts = _extract_list("important_concepts", cleaned)

        if not overview and not cleaned.startswith("{"):
            # Plain text fallback
            overview = cleaned[:400]
            detailed = cleaned

        payload = {
            "overview": overview,
            "key_takeaways": takeaways,
            "important_concepts": concepts,
            "detailed_summary": detailed,
            "timestamps": [],
        }

    if not isinstance(payload, dict):
        payload = {
            "overview": str(cleaned)[:400],
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



def _save_custom_transcript(text: str) -> Path:
    transcript_path = Path(__file__).resolve().parents[2] / "transcript.txt"
    transcript_path.write_text(text, encoding="utf-8")
    return transcript_path


def _snippets_to_text(snippets) -> str:
    """Convert a list of transcript snippets (dicts or objects) to plain text."""
    return " ".join(_get_snippet_attr(s, "text", "") for s in snippets if _get_snippet_attr(s, "text", ""))


@router.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    try:
        transcript = None
        transcript_path = None

        if request.transcript_snippets:
            transcript = request.transcript_snippets
            # Snippets can be dicts (from Chrome extension) or pydantic models
            text = _snippets_to_text([
                s.model_dump() if hasattr(s, 'model_dump') else (s if isinstance(s, dict) else vars(s))
                for s in request.transcript_snippets
            ])
            if not text.strip():
                raise ValueError("Transcript snippets contained no text content.")
            logger.info("Using client-side transcript snippets (%d items)", len(request.transcript_snippets))
            transcript_path = _save_custom_transcript(text)
        elif request.transcript_text:
            text = request.transcript_text
            transcript_path = _save_custom_transcript(text)
        elif request.video_id:
            logger.info("Fetching transcript server-side for video_id=%s", request.video_id)
            transcript = _fetch_transcript(request.video_id)
            transcript_path = _save_video_transcript(request.video_id)

        if transcript is not None and (request.start_time is not None or request.end_time is not None):
            section_path = _write_section_transcript(transcript, request.start_time, request.end_time)
            transcript_path = section_path

        if not transcript_path:
            raise ValueError("No transcript source provided. Please open a YouTube video with captions enabled.")

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
        logger.exception("RAG processing failed")
        err_msg = str(exc)
        if "No transcript" in err_msg or "Could not retrieve a transcript" in err_msg or "IpBlocked" in err_msg or "RequestBlocked" in err_msg:
            detail = (
                "Could not fetch transcript from YouTube servers (IP may be blocked on this host). "
                "The Chrome extension will automatically send the transcript from your browser — "
                "make sure you are on a YouTube video page with captions enabled."
            )
        elif "GEMINI_API_KEY" in err_msg:
            detail = (
                "GEMINI_API_KEY is missing. "
                "Get a free key at https://aistudio.google.com/app/apikey and add it to your Render Environment Variables."
            )
        elif "API_KEY_INVALID" in err_msg or "401" in err_msg or "Unauthorized" in err_msg:
            detail = "GEMINI_API_KEY is invalid. Please check the key at https://aistudio.google.com/app/apikey and update it in Render."
        else:
            detail = f"RAG processing failed: {err_msg}"
        raise HTTPException(
            status_code=500,
            detail=detail,
        ) from exc


@router.post("/summary", response_model=SummaryResponse)
def summarize_video(request: SummaryRequest):
    try:
        transcript = None
        if request.transcript_snippets:
            # Normalize snippets to plain dicts so all downstream code handles them uniformly
            transcript = [
                s.model_dump() if hasattr(s, 'model_dump') else (s if isinstance(s, dict) else vars(s))
                for s in request.transcript_snippets
            ]
            logger.info("Using client-side transcript snippets for summary (%d items)", len(transcript))
        elif request.transcript_text:
            transcript = [{"text": request.transcript_text, "start": 0.0, "duration": 0.0}]
        elif request.video_id:
            logger.info("Fetching transcript server-side for summary video_id=%s", request.video_id)
            raw = _fetch_transcript(request.video_id)
            transcript = [
                s if isinstance(s, dict) else {"text": getattr(s, "text", ""), "start": getattr(s, "start", 0.0), "duration": getattr(s, "duration", 0.0)}
                for s in raw
            ]

        if not transcript:
            raise ValueError("No transcript found for this video. Make sure you are on a YouTube video page with captions enabled.")

        evidence = "\n\n".join(
            f"[{_format_timestamp(_get_snippet_attr(snippet, 'start', 0))}] {_get_snippet_attr(snippet, 'text', '')}"
            for snippet in transcript[:80]
            if _get_snippet_attr(snippet, 'text', '')
        )

        system_prompt = (
            "You are a YouTube video summarizer. "
            "Analyze the transcript evidence carefully and return a JSON object with these exact keys: "
            "overview, key_takeaways, important_concepts, detailed_summary, timestamps. "
            "Rules: "
            "overview = 3-5 sentence paragraph describing what the video teaches. "
            "key_takeaways = array of 4-6 short strings (main points the viewer will learn). "
            "important_concepts = array of 4-6 short strings (tools, technologies, or ideas mentioned). "
            "detailed_summary = a paragraph of 5-8 sentences describing the flow and content. "
            "timestamps = array of up to 6 objects with 'time' (mm:ss) and 'label' (what is discussed). "
            "Return ONLY the JSON object, nothing else."
        )
        user_prompt = (
            "Summarize this YouTube video transcript thoroughly. "
            "Extract key topics, technologies, and learning points.\n\n"
            f"TRANSCRIPT:\n{evidence}"
        )

        answer = generate_text(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_new_tokens=1200,
            json_mode=True,
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
            start = _get_snippet_attr(snippet, "start", 0) or 0
            text = (_get_snippet_attr(snippet, "text", "") or "").strip()
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
        logger.exception("Summary generation failed")
        err_msg = str(exc)
        if "No transcript" in err_msg or "Could not retrieve a transcript" in err_msg or "IpBlocked" in err_msg or "RequestBlocked" in err_msg:
            detail = (
                "Could not fetch transcript from YouTube servers (IP may be blocked on this host). "
                "The Chrome extension will automatically send the transcript from your browser — "
                "make sure you are on a YouTube video page with captions enabled."
            )
        elif "GEMINI_API_KEY" in err_msg:
            detail = (
                "GEMINI_API_KEY is missing. "
                "Get a free key at https://aistudio.google.com/app/apikey and add it to your Render Environment Variables."
            )
        elif "API_KEY_INVALID" in err_msg or "401" in err_msg or "Unauthorized" in err_msg:
            detail = "GEMINI_API_KEY is invalid. Please check the key at https://aistudio.google.com/app/apikey and update it in Render."
        else:
            detail = f"Summary generation failed: {err_msg}"
        raise HTTPException(
            status_code=500,
            detail=detail,
        ) from exc
