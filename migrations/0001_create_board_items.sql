CREATE TABLE IF NOT EXISTS board_items (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('card', 'image')),
	content TEXT,
	image_type TEXT,
	image_data BLOB,
	created_at INTEGER NOT NULL,
	CHECK (
		(kind = 'card' AND content IS NOT NULL AND image_type IS NULL AND image_data IS NULL)
		OR
		(kind = 'image' AND content IS NULL AND image_type IS NOT NULL AND image_data IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS board_items_created_at_idx
	ON board_items (created_at, id);
