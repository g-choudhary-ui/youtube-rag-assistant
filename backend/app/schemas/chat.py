
from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    video_id: str | None = None
    start_time: float | None = Field(default=None, ge=0)
    end_time: float | None = Field(default=None, ge=0)


class ChatResponse(BaseModel):
    answer: str
    sources: list[str]
    scores: list[float]


class SummaryRequest(BaseModel):
    video_id: str = Field(min_length=1, max_length=200)


class SummaryResponse(BaseModel):
    overview: str
    key_takeaways: list[str]
    important_concepts: list[str]
    detailed_summary: str
    timestamps: list[dict[str, str | float]]
