CREATE TABLE writing_submissions (
	id TEXT PRIMARY KEY,
	submission_date TEXT NOT NULL,
	slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
	content TEXT NOT NULL,
	word_count INTEGER NOT NULL CHECK (word_count >= 50),
	created_at INTEGER NOT NULL,
	UNIQUE (submission_date, slot)
);

CREATE INDEX writing_submissions_date_idx
	ON writing_submissions (submission_date, slot);

CREATE TABLE writing_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	started_on TEXT NOT NULL,
	last_evaluated_date TEXT NOT NULL,
	last_wipe_at INTEGER
);
