from app.services.rag_engine import ask_rag


def _safe_text(value: str) -> str:
    return value.encode("ascii", errors="replace").decode("ascii")


def evaluate_question(question: str):
    try:
        result = ask_rag(question)
    except Exception as exc:
        return {
            "question": question,
            "status": "ERROR",
            "error": str(exc),
            "sources": 0,
            "grounded": False,
            "answer": "",
        }

    answer = result.get("answer", "")
    sources = result.get("sources", [])
    lower_answer = answer.lower()

    has_context = bool(sources)
    answer_is_not_mentioned = lower_answer.startswith("not mentioned")
    grounded = has_context and not answer_is_not_mentioned

    status = "PASS" if (has_context or answer_is_not_mentioned) else "FAIL"

    return {
        "question": question,
        "status": status,
        "sources": len(sources),
        "grounded": grounded,
        "answer": answer,
    }


eval_questions = [
    # factual / supported by transcript
    "What is Google Summer of Code?",
    "Why should you participate in Google Summer of Code?",
    "What is a proposal in the video?",
    "What is the timeline for Google Summer of Code in this video?",
    "What is the community bonding period?",
    "What are the two major evaluations mentioned in the video?",

    # conceptual / supported by transcript
    "Why does the speaker say consistency matters for GSoC?",
    "What does the speaker say about the role of mentorship in the GSoC journey?",
    "What is the importance of submitting quality pull requests?",

    # tricky / partially phrased but still grounded
    "What is the most important word in your entire GSoC journey?",
    "What does the speaker say about choosing an organization early?",

    # unsupported / out-of-context
    "What does the speaker say about women and the glass ceiling?",
    "What does the speaker say about cricket?",
    "What is the speaker's opinion about electric vehicles?",
    "Which programming language is used to develop Android games in the video?",
    "Who is the President of India?",
]

passed = 0
failed = 0

for question in eval_questions:
    print("\n" + "=" * 60)
    print("QUESTION:", _safe_text(question))
    result = evaluate_question(question)

    print("STATUS:", result["status"])
    print("HAS_CONTEXT:", result["sources"] > 0)
    print("GROUNDED:", result["grounded"])
    print("ANSWER:", _safe_text(result["answer"]))

    if result["status"] == "ERROR":
        print("ERROR:", _safe_text(result["error"]))

    if result["status"] == "PASS":
        passed += 1
    else:
        failed += 1

print("\n" + "=" * 60)
print(f"SUMMARY: {passed} passed, {failed} failed")
