# AlzKB Knowledge Graph Query Skill

## Overview

The **alzkb-graph-query** skill enables agentic deep graph reasoning on the alzkb.ai Alzheimer's knowledge graph. This skill combines LLM-powered reasoning with precise Cypher queries to extract structured information from Neo4j, minimizing hallucinations and maximizing transparency.

## Key Features

- **Agentic Reasoning**: Dynamic Graph of Thoughts approach to query planning
- **Schema Discovery**: Automatically discovers node types and relationships
- **Transparent Queries**: All Cypher queries are visible and vetted before execution
- **Multi-hop Traversal**: Find indirect connections across multiple relationship hops
- **Error Recovery**: Iterative refinement when queries fail
- **Natural Language Synthesis**: Converts graph results into readable answers

## Connection Details

- **Database**: alzkb.ai Neo4j Knowledge Graph
- **Protocol**: bolt://alzkb.ai:7687
- **Port**: 7687 (Neo4j bolt protocol)
- **Driver**: Python `neo4j` package (pre-installed in Docker image)

## ESCARGOT Principles Applied

This skill implements the ESCARGOT methodology:

1. **Schema-Aware Queries**: Auto-discovers graph structure before querying
2. **Dynamic Graph of Thoughts**: Plans query strategy based on question analysis
3. **Transparent Reasoning**: Shows all Cypher queries before execution
4. **Iterative Refinement**: Adjusts queries based on errors or incomplete results
5. **Structured Retrieval**: Minimizes hallucinations through direct database access

## Usage

### Creating Tasks

When creating a job, use prompts that mention:
- Alzheimer's disease or related terms
- Biomarkers, genes, drugs, proteins, pathways
- The alzkb.ai knowledge graph explicitly
- Relationship or connection questions

**Example Prompts:**

```
"Query alzkb.ai to find all biomarkers associated with APOE4"

"What drugs target genes involved in tau pathology according to alzkb.ai?"

"Find the shortest path between amyloid-beta and neuroinflammation in the knowledge graph"

"How many genes are linked to early-onset Alzheimer's disease in alzkb.ai?"

"Explain the relationship between APOE4 and Alzheimer's risk using the knowledge graph"
```

### AI-Powered Skill Recommendation

The EcoXAI orchestrator will **automatically recommend** this skill when you type prompts containing:
- "alzkb", "alzheimer", "alzheimers"
- "knowledge graph", "graph query", "cypher"
- "biomarker", "gene", "pathway", "drug"
- "apoe", "tau", "amyloid"

### Manual Selection

You can also manually select the skill when creating a job:
1. Click "+ Create Agent Task"
2. Type your prompt
3. Wait for AI skill recommendations
4. Ensure `org:alzkb-graph-query` is checked
5. Create the job

## Output Format

The skill generates three artifacts in `/workspace/output/`:

1. **alzkb_answer.md**: Natural language answer with supporting evidence from the graph
2. **schema.json**: Discovered graph schema (node types, relationships)
3. **query_log.txt** (optional): Transparent log of Cypher queries and reasoning steps

## Example Workflow

### Question: "What is APOE4 and how does it relate to Alzheimer's disease?"

**Phase 1: Schema Discovery**
```
Discovered node types: [Gene, Disease, Protein, Pathway, Biomarker, Drug]
Discovered relationships: [ASSOCIATED_WITH, TARGETS, REGULATES, INCREASES_RISK]
```

**Phase 2: Question Analysis**
```
Intent: definition + relationship
Entities detected: [apoe, apoe4, alzheimer]
Query strategy: entity_lookup + relationship_query
```

**Phase 3: Cypher Generation**
```cypher
MATCH (g:Gene)-[r]-(d:Disease)
WHERE g.name =~ '(?i).*APOE.*' AND d.name =~ '(?i).*Alzheimer.*'
RETURN g.name AS gene, type(r) AS relationship,
       d.name AS disease, r.confidence AS confidence
LIMIT 20
```

**Phase 4: Results**
```
Retrieved 15 records from knowledge graph
- APOE4 INCREASES_RISK Alzheimer's Disease (confidence: 0.95)
- APOE4 ASSOCIATED_WITH Late-Onset AD (confidence: 0.89)
...
```

**Phase 5: Answer Synthesis**
```markdown
# Answer

Based on the alzkb.ai knowledge graph:

1. **APOE4** (Gene)
   - name: Apolipoprotein E4
   - id: APOE4
   - function: Lipid metabolism, cholesterol transport

2. **Relationship to Alzheimer's Disease**
   - INCREASES_RISK: Alzheimer's Disease (confidence: 0.95)
   - Associated with 3x higher risk in heterozygotes
   - 15x higher risk in homozygotes
```

## Advanced Query Patterns

### Multi-Hop Reasoning

Find indirect connections between entities:

```cypher
MATCH path = (g:Gene)-[*1..3]-(d:Disease)
WHERE g.name =~ '(?i).*APOE.*' AND d.name =~ '(?i).*Alzheimer.*'
RETURN [node in nodes(path) | node.name] AS path
LIMIT 5
```

### Aggregation

Count relationships by type:

```cypher
MATCH (g:Gene)-[r]->(d:Disease)
WHERE d.name =~ '(?i).*Alzheimer.*'
RETURN type(r) AS relationship_type, count(r) AS count
ORDER BY count DESC
```

### Property Filtering

Find high-confidence associations:

```cypher
MATCH (g:Gene)-[r:ASSOCIATED_WITH]->(d:Disease)
WHERE d.name =~ '(?i).*Alzheimer.*' AND r.confidence > 0.8
RETURN g.name, r.confidence, r.evidence_count
ORDER BY r.confidence DESC
```

## Technical Details

### Python Class: AlzKBAgent

The skill provides an `AlzKBAgent` class with the following methods:

- `initialize()`: Discover graph schema
- `analyze_question(question)`: Perform Graph of Thoughts reasoning
- `query(question)`: Generate, execute, and synthesize answer
- `discover_schema()`: Auto-discover node types and relationships
- `synthesize_answer()`: Convert graph results to natural language

### Environment Variables

The skill reads these environment variables:

- `TASK_QUESTION`: The user's question (optional, defaults to example)
- `NEO4J_PASSWORD`: Password for Neo4j connection (if required)

### Dependencies

- **neo4j**: Python driver for Neo4j (pre-installed in Docker image)
- Standard library: `os`, `json`

### Error Handling

The skill gracefully handles:
- Connection failures → Returns clear error message
- Unknown properties → Suggests checking schema
- Unknown labels → Suggests verifying node types
- Empty results → Provides helpful fallback message

## Comparison with Traditional RAG

| Feature | Traditional RAG | ESCARGOT + alzkb-graph-query |
|---------|----------------|------------------------------|
| **Accuracy** | Moderate (prone to hallucinations) | High (structured retrieval) |
| **Transparency** | Black box | Full query visibility |
| **Reasoning** | Implicit | Explicit Graph of Thoughts |
| **Data Source** | Vector embeddings | Direct graph database |
| **Verification** | Difficult | Easy (query code review) |
| **Multi-hop** | Limited | Native support |

## Troubleshooting

### Connection Refused

If you see "Connection refused" error:
- Verify port 7687 is accessible
- Check if alzkb.ai is online
- Ensure Docker container has network access

### Empty Results

If queries return no results:
- Check entity names (case-insensitive matching is used)
- Verify schema discovery worked
- Try broader search terms
- Check the `schema.json` artifact for available node types

### Authentication Error

If you see "authentication failed":
- Set `NEO4J_PASSWORD` environment variable
- Contact alzkb.ai administrators for credentials

### Timeout

If queries timeout:
- Reduce query complexity (use `LIMIT` clause)
- Avoid very deep multi-hop queries (limit to 2-3 hops)
- Check alzkb.ai server status

## Future Enhancements

Potential improvements for this skill:

- [ ] LLM-powered query generation (replace heuristics)
- [ ] Query result caching
- [ ] Visualization of graph paths
- [ ] Support for more complex graph patterns (shortest path, community detection)
- [ ] Integration with other biomedical ontologies (UMLS, SNOMED)

## References

- **Research Paper**: [Agentic Deep Graph Reasoning Yields Self-Organizing Knowledge Networks](https://arxiv.org/html/2502.13025v1)
- **Neo4j Cypher**: [Documentation](https://neo4j.com/docs/cypher-manual/current/)
- **AlzKB.ai**: Alzheimer's Knowledge Base
