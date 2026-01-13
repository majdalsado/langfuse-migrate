# Langfuse Prompt Transfer Tool

Transfer all prompts from one Langfuse instance to another. Perfect for migrating from Langfuse Cloud (US or EU) to a self-hosted private instance.

## Features

- 🚀 Transfer all prompts with their configurations
- 📋 Preserves prompt type (text/chat), config, labels, and tags
- 🔄 Option to transfer all versions or just the latest
- 🔍 Dry-run mode to preview changes before applying
- 📊 Detailed transfer summary with error reporting
- 🔌 Zero dependencies - uses only Node.js built-in modules

## Configuration

### Set your environment variables:

```bash
# Source instance (Langfuse US Cloud)
export SOURCE_LANGFUSE_PUBLIC_KEY="pk-lf-..."
export SOURCE_LANGFUSE_SECRET_KEY="sk-lf-..."
export SOURCE_LANGFUSE_BASE_URL="https://us.cloud.langfuse.com"

# Destination instance (your private instance)
export DEST_LANGFUSE_PUBLIC_KEY="pk-lf-..."
export DEST_LANGFUSE_SECRET_KEY="sk-lf-..."
export DEST_LANGFUSE_BASE_URL="https://your-private-langfuse.example.com"
```

## Usage

### Basic Transfer (Latest Versions Only)

```bash
node transfer-prompts.js
```

### Dry Run (Preview Without Making Changes)

```bash
DRY_RUN=true node transfer-prompts.js
# or
pnpm dry-run
```

### Transfer All Versions

```bash
TRANSFER_ALL_VERSIONS=true node transfer-prompts.js
# or
pnpm transfer-all
```

## Langfuse Instance URLs

| Instance    | Base URL                           |
| ----------- | ---------------------------------- |
| US Cloud    | `https://us.cloud.langfuse.com`    |
| EU Cloud    | `https://cloud.langfuse.com`       |
| HIPAA US    | `https://hipaa.cloud.langfuse.com` |
| Self-hosted | Your custom URL                    |

## What Gets Transferred

For each prompt, the tool transfers:

| Field    | Description                            |
| -------- | -------------------------------------- |
| `name`   | Prompt name (including folder paths)   |
| `type`   | `text` or `chat`                       |
| `prompt` | The actual prompt content              |
| `config` | Model parameters, schemas, etc.        |
| `labels` | Deployment labels (e.g., `production`) |
| `tags`   | Custom tags                            |

> **Note:** The `latest` label is automatically managed by Langfuse and is excluded from transfers.

## Prompt References (Composability)

This tool preserves prompt references using Langfuse's composability syntax:

```
@@@langfusePrompt:name=OtherPrompt|label=production@@@
```

References are transferred as-is (unresolved) so they work correctly in the destination instance.

### Important Note: Handling Dependent Prompts

The tool does **not** build a dependency graph, so prompts are transferred in arbitrary order. If a prompt references another prompt that hasn't been created yet, you'll see errors like:

```
[ERROR] Errors:
  - my_prompt: HTTP 400: {"message":"Prompt dependency not found: BasePrompt - label latest","error":"InvalidRequestError"}
```

**Workaround:** Run the script twice.

1. **First run** - Creates all prompts without dependencies (dependent prompts will fail)
2. **Second run** - Creates dependent prompts (now that their dependencies exist)

Note: This will create 2 versions for dependent prompts. You can clean up the extra versions manually in the Langfuse UI if needed.

> **Future Improvement:** Build a dependency graph to transfer prompts in topological order, ensuring dependencies are created before dependents.

## API Reference

The tool uses the Langfuse Public API v2:

| Endpoint                        | Method | Description                            |
| ------------------------------- | ------ | -------------------------------------- |
| `/api/public/v2/prompts`        | GET    | List all prompts                       |
| `/api/public/v2/prompts/{name}` | GET    | Get a specific prompt                  |
| `/api/public/v2/prompts`        | POST   | Create a new prompt version            |
| `/api/public/projects`          | GET    | Get project info (for connection test) |

For full API documentation, see: https://api.reference.langfuse.com

## License

MIT
