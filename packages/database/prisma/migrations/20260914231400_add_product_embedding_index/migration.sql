-- HNSW index for cosine-distance nearest-neighbor search on Product.embedding.
-- Chosen over ivfflat: no upfront training/"lists" tuning needed, and it
-- handles inserts into a small/growing catalog well (see docs/ARCHITECTURE.md
-- AI/MCP layer section on why pgvector was picked over a dedicated vector DB).
CREATE INDEX "Product_embedding_idx" ON "Product" USING hnsw ("embedding" vector_cosine_ops);
