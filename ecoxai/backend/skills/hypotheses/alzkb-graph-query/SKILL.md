---
name: alzkb-graph-query
description: Query alzkb.ai Alzheimer's knowledge graph using Neo4j Cypher. Use when answering questions about Alzheimer's disease, genes, drugs, biological processes, pathways, symptoms, molecular functions, cellular components, body parts, or drug classes from the alzkb.ai knowledge base. Triggers on queries like "find genes associated with...", "what drugs treat...", "which biological processes involve...", "how is X related to Y", or "query the alzkb knowledge graph".
when: use when answering questions about Alzheimer's disease, biomarkers, drugs, genes, pathways, or clinical relationships from alzkb.ai
visibility: org
tags: [knowledge-graph, neo4j, cypher, alzheimers, biomedical]
author: system
version: 1.0.0
---

# AlzKB Knowledge Graph Query

Query the alzkb.ai Alzheimer's knowledge graph using Neo4j and Cypher.

## Connection

```python
from neo4j import GraphDatabase

driver = GraphDatabase.driver(
    "bolt://alzkb.ai:7687",
    auth=("neo4j", "")  # Add password if required
)

def query(cypher):
    with driver.session() as session:
        result = session.run(cypher)
        return [record.data() for record in result]

# Always close when done
driver.close()
```

## Graph Schema

### Node Types

- `BiologicalProcess` - Properties: `commonName`
- `BodyPart` - Properties: `commonName`
- `CellularComponent` - Properties: `commonName`
- `Disease` - Properties: `commonName`
- `Drug` - Properties: `commonName`
- `DrugClass` - Properties: `commonName`
- `Gene` - Properties: `commonName`, `geneSymbol`, `typeOfGene`
- `MolecularFunction` - Properties: `commonName`
- `Pathway` - Properties: `commonName`
- `Symptom` - Properties: `commonName`

### Relationships

- `(:Drug)-[:CHEMICALBINDSGENE]->(:Gene)`
- `(:Drug)-[:CHEMICALDECREASESEXPRESSION]->(:Gene)`
- `(:Drug)-[:CHEMICALINCREASESEXPRESSION]->(:Gene)`
- `(:Drug)-[:DRUGINCLASS]->(:DrugClass)`
- `(:Drug)-[:DRUGCAUSESEFFECT]->(:Disease)`
- `(:Drug)-[:DRUGTREATSDISEASE]->(:Disease)`
- `(:Gene)-[:GENEPARTICIPATESINBIOLOGICALPROCESS]->(:BiologicalProcess)`
- `(:Gene)-[:GENEINPATHWAY]->(:Pathway)`
- `(:Gene)-[:GENEINTERACTSWITHGENE]->(:Gene)`
- `(:Gene)-[:GENEHASMOLECULARFUNCTION]->(:MolecularFunction)`
- `(:Gene)-[:GENEASSOCIATEDWITHCELLULARCOMPONENT]->(:CellularComponent)`
- `(:Gene)-[:GENEASSOCIATESWITHDISEASE]->(:Disease)`
- `(:Symptom)-[:SYMPTOMMANIFESTATIONOFDISEASE]->(:Disease)`
- `(:BodyPart)-[:BODYPARTUNDEREXPRESSESGENE]->(:Gene)`
- `(:BodyPart)-[:BODYPARTOVEREXPRESSESGENE]->(:Gene)`
- `(:Disease)-[:DISEASELOCALIZESTOANATOMY]->(:BodyPart)`
- `(:Disease)-[:DISEASEASSOCIATESWITHDISEASET]->(:Disease)`

## Query Patterns

### Find entities

```cypher
-- Find gene by symbol or common name
MATCH (g:Gene)
WHERE toLower(g.commonName) CONTAINS 'apoe'
RETURN g.geneSymbol, g.commonName, g.typeOfGene, properties(g)
LIMIT 10

-- Find drug by name
MATCH (d:Drug)
WHERE toLower(d.commonName) CONTAINS 'donepezil'
RETURN d.commonName, properties(d)
LIMIT 10

-- Find any node containing term
MATCH (n)
WHERE toLower(n.commonName) CONTAINS 'tau'
RETURN labels(n) AS type, n.commonName, properties(n)
LIMIT 10
```

### Find relationships

```cypher
-- What diseases is this gene associated with?
MATCH (g:Gene)-[r:GENEASSOCIATESWITHDISEASE]->(d:Disease)
WHERE toLower(g.commonName) CONTAINS 'apoe'
RETURN g.geneSymbol, g.commonName, d.commonName AS disease
LIMIT 20

-- What drugs treat a specific disease?
MATCH (drug:Drug)-[r:DRUGTREATSDISEASE]->(d:Disease)
WHERE toLower(d.commonName) CONTAINS 'alzheimer'
RETURN drug.commonName AS drug, d.commonName AS disease
LIMIT 20

-- Drugs that bind to specific genes
MATCH (drug:Drug)-[r:CHEMICALBINDSGENE]->(g:Gene)
WHERE toLower(g.commonName) CONTAINS 'app'
RETURN drug.commonName AS drug, g.geneSymbol AS gene, g.commonName
```

### Multi-hop paths

```cypher
-- Find paths from gene to disease
MATCH path = (g:Gene)-[*1..3]-(d:Disease)
WHERE toLower(g.commonName) CONTAINS 'apoe' AND toLower(d.commonName) CONTAINS 'alzheimer'
RETURN [n in nodes(path) | labels(n)[0] + ':' + n.commonName] AS path
LIMIT 10

-- Gene to biological processes to diseases
MATCH path = (g:Gene)-[:GENEPARTICIPATESINBIOLOGICALPROCESS]->(bp:BiologicalProcess)<-[:GENEPARTICIPATESINBIOLOGICALPROCESS]-(g2:Gene)-[:GENEASSOCIATESWITHDISEASE]->(d:Disease)
WHERE toLower(g.commonName) CONTAINS 'apoe'
RETURN g.geneSymbol, bp.commonName AS process, g2.geneSymbol AS related_gene, d.commonName AS disease
LIMIT 10
```

### Aggregations

```cypher
-- Count genes associated with Alzheimer's
MATCH (g:Gene)-[r:GENEASSOCIATESWITHDISEASE]->(d:Disease)
WHERE toLower(d.commonName) CONTAINS 'alzheimer'
RETURN count(DISTINCT g) AS gene_count

-- Count drugs that treat diseases
MATCH (drug:Drug)-[r:DRUGTREATSDISEASE]->(d:Disease)
RETURN d.commonName AS disease, count(drug) AS drug_count
ORDER BY drug_count DESC
LIMIT 10

-- Genes by biological process
MATCH (g:Gene)-[r:GENEPARTICIPATESINBIOLOGICALPROCESS]->(bp:BiologicalProcess)
RETURN bp.commonName AS process, count(g) AS gene_count
ORDER BY gene_count DESC
LIMIT 10
```

## Cypher Tips

- Always use `LIMIT` to avoid large result sets
- Node property is `commonName` (genes also have `geneSymbol`, `typeOfGene`)
- Get all properties: `properties(n)`
- Check property existence: `WHERE exists(n.commonName)`
- Combine conditions: `WHERE n.commonName CONTAINS 'text' AND exists(n.geneSymbol)`

## Error Handling

```python
try:
    with driver.session() as session:
        result = session.run(query)
        return [record.data() for record in result]
except Exception as e:
    print(f"Query failed: {e}")
    return None
```

## Complete Example

```python
from neo4j import GraphDatabase

driver = GraphDatabase.driver("bolt://alzkb.ai:7687", auth=("neo4j", ""))

# Find APOE gene associations with diseases
with driver.session() as session:
    result = session.run("""
        MATCH (g:Gene)-[r:GENEASSOCIATESWITHDISEASE]->(d:Disease)
        WHERE toLower(g.commonName) CONTAINS 'apoe'
        RETURN g.geneSymbol AS gene, g.commonName AS gene_name, 
               d.commonName AS disease
        LIMIT 20
    """)
    
    for record in result:
        print(f"{record['gene']} ({record['gene_name']}) → {record['disease']}")

driver.close()
```

## Dependencies

```bash
pip install neo4j
```