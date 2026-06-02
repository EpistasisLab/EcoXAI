# EcoXAI
Multiagent automated biomedical analysis framework. Fully AI harnessed agents generating hypotheses with testing and validation.

# Dataset Upload
Simply copy the dataset to the ecoxai/backend/datasets directory.

# Set up the environment
export CLAUDE_CODE_USE_FOUNDRY=1 
export ANTHROPIC_FOUNDRY_RESOURCE=...
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6' 
export ANTHROPIC_FOUNDRY_API_KEY=...

# Run the local server
cd ecoxai/backend
npm install
npm start


# Run the local web server
cd ecoxai/frontend
python3 -m http.server 3000