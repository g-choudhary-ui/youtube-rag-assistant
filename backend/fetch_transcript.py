from youtube_transcript_api import YouTubeTranscriptApi

video_id = "J5_-l7WIO_w"
api = YouTubeTranscriptApi()

try:
    try:
        transcript = api.fetch(video_id, languages=["en"])
    except Exception:
        try:
            transcript = api.fetch(video_id, languages=["hi"])
        except Exception:
            transcript = api.fetch(video_id)

    transcript_text = " ".join(snippet.text for snippet in transcript)

    with open("transcript.txt", "w", encoding="utf-8") as f:
        f.write(transcript_text)

    print("Transcript saved successfully!")

except Exception as e:
    print(type(e).__name__, e)
