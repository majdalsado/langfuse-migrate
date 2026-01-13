# Langfuse Prompt Transfer Tool

Transfer all prompts from one Langfuse instance to another. Perfect for migrating from Langfuse Cloud (US or EU) to a self-hosted private instance.

## Features

- 🚀 Transfer all prompts with their configurations
- 📋 Preserves prompt type (text/chat), config, labels, and tags
- 🔄 Option to transfer all versions or just the latest
- 🔍 Dry-run mode to preview changes before applying
- 📊 Detailed transfer summary with error reporting
- 📦 JSON export/import mode for offline backup and version control
- 🔌 Zero dependencies - uses only Node.js built-in modules

## Configuration

Set your credentials via environment variables (or `.env` file):

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

```
npx ts-node transfer-prompts.ts [command] [options]
```

### Commands

| Command    | Description                                         |
| ---------- | --------------------------------------------------- |
| `transfer` | Transfer prompts directly source → destination (default) |
| `export`   | Export prompts from source to a JSON file           |
| `import`   | Import prompts from a JSON file to destination      |

### Options

| Option           | Description                                      |
| ---------------- | ------------------------------------------------ |
| `--dry-run`      | Preview changes without making them              |
| `--all-versions` | Transfer all versions (not just latest)          |
| `--file <path>`  | JSON file path for export/import (default: prompts.json) |
| `--help, -h`     | Show help message                                |

### Examples

```bash
# Basic transfer (latest versions only)
npx ts-node transfer-prompts.ts

# Dry run (preview without making changes)
npx ts-node transfer-prompts.ts --dry-run

# Transfer all versions
npx ts-node transfer-prompts.ts --all-versions

# Export prompts to JSON
npx ts-node transfer-prompts.ts export --file backup.json

# Import prompts from JSON
npx ts-node transfer-prompts.ts import --file backup.json

# Dry-run import (preview without changes)
npx ts-node transfer-prompts.ts import --file backup.json --dry-run
```

### JSON File Format

```json
{
  "exportedAt": "2025-01-13T10:00:00.000Z",
  "sourceBaseUrl": "https://us.cloud.langfuse.com",
  "prompts": [
    {
      "name": "my-prompt",
      "type": "text",
      "prompt": "You are a helpful assistant...",
      "config": {},
      "labels": ["production"],
      "tags": ["v1"]
    }
  ]
}
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
