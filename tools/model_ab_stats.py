"""Summarize marked Codex runner jobs using their saved metadata."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime
import json
from pathlib import Path
import re
from statistics import median
import sys


CRITERIA = ("met", "blocked", "not_met")
REVIEWS = ("verified", "accepted_deviations", "needs_changes")
JOB_ID = re.compile(r"(\d{8})-\d{6}-[0-9a-f]{6}")


def metadata(file):
    if file.is_symlink():
        return {}
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        print(f"Could not read metadata: {file.parent.name}/{file.name}", file=sys.stderr)
        return {}


def collect(directory, since):
    groups = defaultdict(list)
    for job in directory.iterdir():
        match = JOB_ID.fullmatch(job.name)
        if not match or match[1] < since or not job.is_dir() or job.is_symlink():
            continue
        args_file = job / "args.json"
        task = metadata(args_file)
        context = task.get("context") or {}
        routing = context.get("routing") or {}
        if routing.get("ab") is not True or not routing.get("model"):
            continue
        try:
            started = args_file.stat().st_mtime
        except FileNotFoundError:
            continue
        result = metadata(job / "result.json")
        review = metadata(job / "reviews.json").get("latest") or {}
        groups[routing["model"]].append({
            "id": job.name,
            "started": started,
            "thread": result.get("thread_id") or task.get("resume"),
            "parent": (context.get("continuation") or {}).get("parent_job_id") or routing.get("parent_job_id"),
            "execution": result.get("execution_status") or result.get("status"),
            "error": result.get("error_kind") or ("unknown" if result.get("status") == "failed" else None),
            "criteria": result.get("criteria_counts") or {},
            "review": review.get("status"),
            "duration": result.get("duration_s"),
        })
    return groups


def shares(counts, labels, total):
    return {label: counts[label] / total if total else 0 for label in labels}


def summarize(jobs):
    thread_keys = {}
    thread_outcomes = {}
    errors, criteria, reviews = Counter(), Counter(), Counter()
    durations = []
    for job in sorted(jobs, key=lambda job: (job["started"], job["id"])):
        key = thread_keys.get(job["parent"], ("thread", job["thread"]) if job["thread"] else ("job", job["id"]))
        thread_keys[job["id"]] = key
        previous = thread_outcomes.get(key)
        review = job["review"]
        # An unfinished follow-up still owes the last review's rework.
        thread_outcomes[key] = review if review in REVIEWS else "needs_changes" if previous == "needs_changes" else "unreviewed"
        if job["error"]:
            errors[job["error"]] += 1
        criteria.update({mark: job["criteria"].get(mark, 0) for mark in CRITERIA})
        reviews[review] += 1
        if job["duration"] is not None:
            durations.append(job["duration"])

    total, threads = len(jobs), len(thread_outcomes)
    return {
        "tasks": total,
        "execution_completion_rate": sum(job["execution"] == "completed" for job in jobs) / total,
        "failure_reasons": dict(sorted(errors.items())),
        "self_report_shares": shares(criteria, CRITERIA, sum(criteria.values())),
        "review_shares": shares(reviews, REVIEWS, total),
        "threads": threads,
        "final_outcome_shares": shares(Counter(thread_outcomes.values()), (*REVIEWS, "unreviewed"), threads),
        "mean_rework_rounds": (total - threads) / threads,
        "median_duration_s": median(durations) if durations else None,
        "model_refusals": errors["model_refused"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs-dir", type=Path, default=Path.home() / ".local/state/codex-runner/jobs")
    parser.add_argument("--since", default="", metavar="YYYYMMDD", help="Include jobs from this runner date onward")
    parser.add_argument("--json", action="store_true", help="Print machine-readable totals")
    options = parser.parse_args()
    if options.since:
        try:
            if not re.fullmatch(r"[0-9]{8}", options.since):
                raise ValueError
            datetime.strptime(options.since, "%Y%m%d")
        except ValueError:
            parser.error("--since must be a date in YYYYMMDD format")
    if not options.jobs_dir.is_dir():
        parser.error(f"jobs directory does not exist: {options.jobs_dir}")
    summary = {model: summarize(jobs) for model, jobs in sorted(collect(options.jobs_dir, options.since).items())}
    if options.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    elif not summary:
        print("No A/B jobs found.")
    else:
        for model, stats in summary.items():
            print(model)
            for name, value in stats.items():
                if name.endswith("_shares"):
                    value = ", ".join(f"{label}={share:.1%}" for label, share in value.items())
                elif name == "execution_completion_rate":
                    value = f"{value:.1%}"
                elif name == "mean_rework_rounds":
                    value = f"{value:.2f}"
                print(f"  {name}: {value}")


if __name__ == "__main__":
    main()
