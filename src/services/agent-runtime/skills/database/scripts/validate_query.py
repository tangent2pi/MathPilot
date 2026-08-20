#!/usr/bin/env python3
import re, sys
from pathlib import Path
if len(sys.argv)!=2: raise SystemExit("usage: validate_query.py QUERY.sql")
sql=Path(sys.argv[1]).read_text(encoding="utf-8").strip()
clean=re.sub(r"--.*?$|/\*.*?\*/","",sql,flags=re.M|re.S).strip()
forbidden=r"\b(insert|update|delete|merge|alter|drop|create|grant|revoke|copy|set|reset|call|do|execute|prepare|listen|notify|vacuum|truncate)\b"
if not clean or re.search(forbidden,clean,re.I): raise SystemExit("query must be read-only and must not alter session identity")
if not re.match(r"^(select|with)\b",clean,re.I): raise SystemExit("query must start with SELECT or WITH")
if clean.count(";")>1 or (";" in clean[:-1]): raise SystemExit("exactly one statement is allowed")
allowed=("mathpilot_agent_library(","mathpilot_agent_question(","mathpilot_agent_student_context(","mathpilot_agent_session_context(")
if not any(name in clean.lower() for name in allowed): raise SystemExit("query must call an approved scoped function")
print("valid read-only scoped query")
