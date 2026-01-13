#!/usr/bin/env npx ts-node

/**
 * Langfuse Prompt Transfer Tool
 *
 * Transfers all prompts from one Langfuse instance (e.g., US Cloud)
 * to another instance (e.g., private self-hosted).
 *
 * Usage:
 *   npx ts-node transfer-prompts.ts [command] [options]
 *
 * Commands:
 *   transfer    Transfer prompts directly from source to destination (default)
 *   export      Export prompts from source to a JSON file
 *   import      Import prompts from a JSON file to destination
 *
 * Options:
 *   --dry-run           Preview changes without making them
 *   --all-versions      Transfer all versions (not just latest)
 *   --file <path>       JSON file path for export/import (default: prompts.json)
 *   --help, -h          Show this help message
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import { URL } from "url";
import dotenv from "dotenv";
dotenv.config();

// ============================================================================
// Types
// ============================================================================

interface Config {
  source: {
    publicKey: string;
    secretKey: string;
    baseUrl: string;
  };
  dest: {
    publicKey: string;
    secretKey: string;
    baseUrl: string;
  };
  transferAllVersions: boolean;
  dryRun: boolean;
  mode: "transfer" | "export" | "import";
  jsonFile: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface CreatePromptRequest {
  name: string;
  type: "text" | "chat";
  prompt: string | ChatMessage[];
  config?: Record<string, unknown>;
  labels?: string[];
  tags?: string[];
}

interface PromptsExport {
  exportedAt: string;
  sourceBaseUrl: string;
  prompts: CreatePromptRequest[];
}

interface PromptMeta {
  name: string;
  versions: number[];
  labels: string[];
  tags: string[];
}

interface PromptData {
  name: string;
  type: "text" | "chat";
  prompt: string | ChatMessage[];
  config?: Record<string, unknown>;
  labels?: string[];
  tags?: string[];
  version?: number;
}

interface ListPromptsResponse {
  data: PromptMeta[];
  meta?: {
    page?: number;
    limit?: number;
    totalItems?: number;
    totalPages?: number;
  };
}

interface ProjectsResponse {
  data?: Array<{ name?: string }>;
}

interface TransferStats {
  total: number;
  transferred: number;
  skipped: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
}

interface TransferOptions {
  dryRun?: boolean;
  transferAllVersions?: boolean;
}

type LogType = "info" | "success" | "warning" | "error" | "skip";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

interface CliArgs {
  mode: "transfer" | "export" | "import";
  dryRun: boolean;
  allVersions: boolean;
  file: string;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    mode: "transfer",
    dryRun: false,
    allVersions: false,
    file: "prompts.json",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "transfer":
      case "export":
      case "import":
        result.mode = arg;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--all-versions":
        result.allVersions = true;
        break;
      case "--file":
        if (i + 1 < args.length) {
          result.file = args[++i];
        } else {
          console.error("Error: --file requires a path argument");
          process.exit(1);
        }
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          console.error('Use --help for usage information');
          process.exit(1);
        }
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Langfuse Prompt Transfer Tool

Usage:
  npx ts-node transfer-prompts.ts [command] [options]

Commands:
  transfer    Transfer prompts directly from source to destination (default)
  export      Export prompts from source to a JSON file
  import      Import prompts from a JSON file to destination

Options:
  --dry-run           Preview changes without making them
  --all-versions      Transfer all versions (not just latest)
  --file <path>       JSON file path for export/import (default: prompts.json)
  --help, -h          Show this help message

Environment Variables (for credentials):
  SOURCE_LANGFUSE_PUBLIC_KEY    Source instance public key
  SOURCE_LANGFUSE_SECRET_KEY    Source instance secret key
  SOURCE_LANGFUSE_BASE_URL      Source instance URL (default: https://us.cloud.langfuse.com)
  DEST_LANGFUSE_PUBLIC_KEY      Destination instance public key
  DEST_LANGFUSE_SECRET_KEY      Destination instance secret key
  DEST_LANGFUSE_BASE_URL        Destination instance URL

Examples:
  # Transfer prompts (dry run)
  npx ts-node transfer-prompts.ts --dry-run

  # Transfer all versions
  npx ts-node transfer-prompts.ts --all-versions

  # Export to JSON
  npx ts-node transfer-prompts.ts export --file backup.json

  # Import from JSON (dry run)
  npx ts-node transfer-prompts.ts import --file backup.json --dry-run
`);
}

// Parse CLI arguments
const cliArgs = parseArgs();

// ============================================================================
// Configuration
// ============================================================================

const config: Config = {
  source: {
    publicKey: process.env.SOURCE_LANGFUSE_PUBLIC_KEY || "",
    secretKey: process.env.SOURCE_LANGFUSE_SECRET_KEY || "",
    baseUrl:
      process.env.SOURCE_LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com",
  },
  dest: {
    publicKey: process.env.DEST_LANGFUSE_PUBLIC_KEY || "",
    secretKey: process.env.DEST_LANGFUSE_SECRET_KEY || "",
    baseUrl: process.env.DEST_LANGFUSE_BASE_URL || "",
  },
  transferAllVersions: cliArgs.allVersions,
  dryRun: cliArgs.dryRun,
  mode: cliArgs.mode,
  jsonFile: cliArgs.file,
};

// ============================================================================
// HTTP Client
// ============================================================================

class LangfuseClient {
  private publicKey: string;
  private secretKey: string;
  private baseUrl: string;
  private protocol: typeof https | typeof http;
  private hostname: string;
  private port: number;
  private basePath: string;

  constructor(publicKey: string, secretKey: string, baseUrl: string) {
    this.publicKey = publicKey;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash

    const url = new URL(this.baseUrl);
    this.protocol = url.protocol === "https:" ? https : http;
    this.hostname = url.hostname;
    this.port = url.port
      ? parseInt(url.port)
      : url.protocol === "https:"
      ? 443
      : 80;
    this.basePath = url.pathname.replace(/\/$/, "");
  }

  private getAuthHeader(): string {
    const credentials = Buffer.from(
      `${this.publicKey}:${this.secretKey}`
    ).toString("base64");
    return `Basic ${credentials}`;
  }

  async request<T>(
    method: string,
    path: string,
    body: unknown = null
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const fullPath = `${this.basePath}${path}`;

      const options: https.RequestOptions = {
        hostname: this.hostname,
        port: this.port,
        path: fullPath,
        method: method,
        headers: {
          Authorization: this.getAuthHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      };

      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : ({} as T));
            } catch {
              resolve(data as unknown as T);
            }
          } else if (res.statusCode === 204) {
            resolve({} as T);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Prompt API Methods
  // -------------------------------------------------------------------------

  /**
   * List all prompts with metadata
   * GET /api/public/v2/prompts
   */
  async listPrompts(
    options: {
      page?: number;
      limit?: number;
      name?: string;
      label?: string;
      tag?: string;
    } = {}
  ): Promise<ListPromptsResponse> {
    const params = new URLSearchParams();
    if (options.page) params.set("page", options.page.toString());
    if (options.limit) params.set("limit", options.limit.toString());
    if (options.name) params.set("name", options.name);
    if (options.label) params.set("label", options.label);
    if (options.tag) params.set("tag", options.tag);

    const query = params.toString();
    const path = `/api/public/v2/prompts${query ? "?" + query : ""}`;
    return this.request<ListPromptsResponse>("GET", path);
  }

  /**
   * Get all prompts with pagination
   */
  async getAllPrompts(): Promise<PromptMeta[]> {
    const allPrompts: PromptMeta[] = [];
    let page = 1;
    const limit = 100;

    while (true) {
      const response = await this.listPrompts({ page, limit });
      const prompts = response.data || [];
      allPrompts.push(...prompts);

      // Check if there are more pages
      const meta = response.meta || {};
      const totalPages = meta.totalPages || 1;

      if (page >= totalPages || prompts.length === 0) {
        break;
      }
      page++;
    }

    return allPrompts;
  }

  /**
   * Get a specific prompt by name
   * GET /api/public/v2/prompts/{promptName}
   *
   * @param options.resolve - Set to false to get raw prompt content without resolving references
   */
  async getPrompt(
    name: string,
    options: { version?: number; label?: string; resolve?: boolean } = {}
  ): Promise<PromptData> {
    // URL encode the prompt name (handles folders like "folder/prompt-name")
    const encodedName = encodeURIComponent(name);
    const params = new URLSearchParams();

    if (options.version !== undefined)
      params.set("version", options.version.toString());
    if (options.label) params.set("label", options.label);
    if (options.resolve === false) params.set("resolve", "false");

    const query = params.toString();
    const path = `/api/public/v2/prompts/${encodedName}${
      query ? "?" + query : ""
    }`;
    return this.request<PromptData>("GET", path);
  }

  /**
   * Create a new prompt version
   * POST /api/public/v2/prompts
   */
  async createPrompt(promptData: CreatePromptRequest): Promise<PromptData> {
    return this.request<PromptData>(
      "POST",
      "/api/public/v2/prompts",
      promptData
    );
  }

  /**
   * Update labels for a specific prompt version
   * PATCH /api/public/v2/prompts/{name}/versions/{version}
   */
  async updatePromptLabels(
    name: string,
    version: number,
    newLabels: string[]
  ): Promise<PromptData> {
    const encodedName = encodeURIComponent(name);
    const path = `/api/public/v2/prompts/${encodedName}/versions/${version}`;
    return this.request<PromptData>("PATCH", path, { newLabels });
  }

  /**
   * Test connection by getting project info
   */
  async testConnection(): Promise<ProjectsResponse> {
    return this.request<ProjectsResponse>("GET", "/api/public/projects");
  }
}

// ============================================================================
// Transfer Logic
// ============================================================================

class PromptTransfer {
  private source: LangfuseClient;
  private dest: LangfuseClient;
  private dryRun: boolean;
  private transferAllVersions: boolean;
  private stats: TransferStats = {
    total: 0,
    transferred: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  constructor(
    sourceClient: LangfuseClient,
    destClient: LangfuseClient,
    options: TransferOptions = {}
  ) {
    this.source = sourceClient;
    this.dest = destClient;
    this.dryRun = options.dryRun || false;
    this.transferAllVersions = options.transferAllVersions || false;
  }

  private log(message: string, type: LogType = "info"): void {
    const prefix: Record<LogType, string> = {
      info: "[INFO]",
      success: "[OK]",
      warning: "[WARN]",
      error: "[ERROR]",
      skip: "[SKIP]",
    };

    console.log(`${prefix[type]} ${message}`);
  }

  /**
   * Test connection to source instance
   */
  private async testSourceConnection(): Promise<void> {
    this.log("Testing connection to source instance...");
    try {
      const sourceInfo = await this.source.testConnection();
      this.log(
        `  Connected to: ${sourceInfo.data?.[0]?.name || "Project"}`,
        "success"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot connect to source: ${errorMessage}`);
    }
  }

  /**
   * Test connection to destination instance
   */
  private async testDestConnection(): Promise<void> {
    this.log("Testing connection to destination instance...");
    try {
      const destInfo = await this.dest.testConnection();
      this.log(
        `  Connected to: ${destInfo.data?.[0]?.name || "Project"}`,
        "success"
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot connect to destination: ${errorMessage}`);
    }
  }

  /**
   * Build a CreatePromptRequest from prompt data
   */
  private buildCreateRequest(prompt: {
    name: string;
    type: "text" | "chat";
    prompt: string | ChatMessage[];
    config?: Record<string, unknown>;
    labels?: string[];
    tags?: string[];
  }): CreatePromptRequest {
    const request: CreatePromptRequest = {
      name: prompt.name,
      type: prompt.type,
      prompt: prompt.prompt,
    };

    if (prompt.config && Object.keys(prompt.config).length > 0) {
      request.config = prompt.config;
    }
    if (prompt.labels && prompt.labels.length > 0) {
      request.labels = prompt.labels.filter((l) => l !== "latest");
    }
    if (prompt.tags && prompt.tags.length > 0) {
      request.tags = prompt.tags;
    }

    return request;
  }

  /**
   * Transfer all prompts from source to destination
   */
  async transferAll(): Promise<TransferStats> {
    console.log("\n" + "=".repeat(60));
    console.log("[START] Langfuse Prompt Transfer Tool");
    console.log("=".repeat(60) + "\n");

    if (this.dryRun) {
      this.log("DRY RUN MODE - No changes will be made\n", "warning");
    }

    // Test connections
    await this.testConnections();

    // Get all prompts from source
    this.log("Fetching prompts from source instance...\n");
    const sourcePrompts = await this.source.getAllPrompts();

    if (sourcePrompts.length === 0) {
      this.log("No prompts found in source instance", "warning");
      return this.stats;
    }

    this.log(`Found ${sourcePrompts.length} prompt(s) in source instance\n`);

    // Get existing prompts from destination to check for duplicates
    const destPrompts = await this.dest.getAllPrompts();
    const destPromptNames = new Set(destPrompts.map((p) => p.name));

    // Process each prompt
    for (const promptMeta of sourcePrompts) {
      await this.transferPrompt(promptMeta, destPromptNames);
    }

    // Print summary
    this.printSummary();

    return this.stats;
  }

  /**
   * Transfer a single prompt with all its versions
   */
  private async transferPrompt(
    promptMeta: PromptMeta,
    existingNames: Set<string>
  ): Promise<void> {
    const { name, versions = [], labels = [] } = promptMeta;
    this.stats.total++;

    console.log(`\n${"─".repeat(50)}`);
    this.log(`Processing: ${name}`);
    this.log(
      `  Versions: ${versions.length}, Labels: ${labels.join(", ") || "none"}`
    );

    try {
      // Determine which versions to transfer
      let versionsToTransfer: number[];

      if (this.transferAllVersions) {
        // Transfer all versions in order
        versionsToTransfer = [...versions].sort((a, b) => a - b);
      } else {
        // Transfer only the latest version
        versionsToTransfer = [Math.max(...versions)];
      }

      for (const version of versionsToTransfer) {
        await this.transferPromptVersion(
          name,
          version,
          existingNames,
          promptMeta
        );
      }

      this.stats.transferred++;
      this.log(`Successfully transferred: ${name}`, "success");
    } catch (error) {
      this.stats.failed++;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.stats.errors.push({ name, error: errorMessage });
      this.log(`Failed to transfer ${name}: ${errorMessage}`, "error");
    }
  }

  /**
   * Transfer a specific version of a prompt
   */
  private async transferPromptVersion(
    name: string,
    version: number,
    _existingNames: Set<string>,
    _promptMeta: PromptMeta
  ): Promise<void> {
    this.log(`  Fetching version ${version}...`);

    // Fetch the full prompt data with resolve=false to preserve prompt references
    const promptData = await this.source.getPrompt(name, { version, resolve: false });
    const createRequest = this.buildCreateRequest(promptData);

    // Log the prompt being transferred
    this.logPromptDetails(createRequest, promptData);

    if (this.dryRun) {
      this.log(`  [DRY RUN] Would create prompt version`, "skip");
      return;
    }

    // Create the prompt in destination
    await this.createPromptInDest(createRequest);
  }

  /**
   * Log prompt details during transfer/import
   */
  private logPromptDetails(
    request: CreatePromptRequest,
    promptData: { type: string; prompt: string | ChatMessage[] }
  ): void {
    this.log(`  Type: ${promptData.type}`);
    if (request.labels && request.labels.length > 0) {
      this.log(`  Labels: ${request.labels.join(", ")}`);
    }
    if (request.tags && request.tags.length > 0) {
      this.log(`  Tags: ${request.tags.join(", ")}`);
    }
    if (request.config) {
      this.log(
        `  Config: ${JSON.stringify(request.config).substring(0, 100)}...`
      );
    }

    // Preview prompt content
    if (promptData.type === "text") {
      const preview =
        typeof promptData.prompt === "string"
          ? promptData.prompt.substring(0, 80)
          : JSON.stringify(promptData.prompt).substring(0, 80);
      this.log(`  Prompt: "${preview}..."`);
    } else if (promptData.type === "chat") {
      const msgCount = Array.isArray(promptData.prompt)
        ? promptData.prompt.length
        : 0;
      this.log(`  Prompt: ${msgCount} message(s)`);
    }
  }

  /**
   * Create a prompt in the destination instance
   */
  private async createPromptInDest(createRequest: CreatePromptRequest): Promise<PromptData> {
    try {
      const result = await this.dest.createPrompt(createRequest);
      this.log(`  Created version ${result.version} in destination`, "success");
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // If prompt already exists, it will add a new version
      if (errorMessage.includes("400") || errorMessage.includes("conflict")) {
        this.log(
          `  Prompt may already exist, attempting to add version...`,
          "warning"
        );
        const result = await this.dest.createPrompt(createRequest);
        this.log(`  Added new version ${result.version}`, "success");
        return result;
      } else {
        throw error;
      }
    }
  }

  /**
   * Test connections to both instances
   */
  private async testConnections(): Promise<void> {
    await this.testSourceConnection();
    await this.testDestConnection();
    console.log();
  }

  /**
   * Print transfer summary
   */
  private printSummary(): void {
    console.log("\n" + "=".repeat(60));
    console.log("[STATS] Transfer Summary");
    console.log("=".repeat(60));
    console.log(`  Total prompts:       ${this.stats.total}`);
    console.log(`  Transferred:         ${this.stats.transferred}`);
    console.log(`  Skipped:             ${this.stats.skipped}`);
    console.log(`  Failed:              ${this.stats.failed}`);

    if (this.stats.errors.length > 0) {
      console.log("\n[ERROR] Errors:");
      for (const { name, error } of this.stats.errors) {
        console.log(`  - ${name}: ${error}`);
      }
    }

    if (this.dryRun) {
      console.log("\n[WARN] This was a DRY RUN - no changes were made");
    }

    console.log("=".repeat(60) + "\n");
  }

  /**
   * Export all prompts to a JSON file
   */
  async exportToJson(filePath: string): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("[START] Langfuse Prompt Export");
    console.log("=".repeat(60) + "\n");

    await this.testSourceConnection();

    // Get all prompts from source
    this.log("\nFetching prompts from source instance...");
    const sourcePrompts = await this.source.getAllPrompts();

    if (sourcePrompts.length === 0) {
      this.log("No prompts found in source instance", "warning");
      return;
    }

    this.log(`Found ${sourcePrompts.length} prompt(s)\n`);

    // Fetch full data for each prompt
    const exportData: PromptsExport = {
      exportedAt: new Date().toISOString(),
      sourceBaseUrl: config.source.baseUrl,
      prompts: [],
    };

    for (const promptMeta of sourcePrompts) {
      const { name, versions = [] } = promptMeta;
      this.stats.total++;

      try {
        // Get the latest version
        const latestVersion = Math.max(...versions);
        this.log(`Exporting: ${name} (version ${latestVersion})...`);

        const promptData = await this.source.getPrompt(name, {
          version: latestVersion,
          resolve: false,
        });

        exportData.prompts.push(this.buildCreateRequest(promptData));
        this.stats.transferred++;
      } catch (error) {
        this.stats.failed++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.stats.errors.push({ name, error: errorMessage });
        this.log(`Failed to export ${name}: ${errorMessage}`, "error");
      }
    }

    // Write to file
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    this.log(`\nExported ${this.stats.transferred} prompt(s) to ${filePath}`, "success");

    if (this.stats.failed > 0) {
      this.log(`Failed to export ${this.stats.failed} prompt(s)`, "error");
      for (const { name, error } of this.stats.errors) {
        console.log(`  - ${name}: ${error}`);
      }
    }

    console.log("=".repeat(60) + "\n");
  }

  /**
   * Import prompts from a JSON file
   */
  async importFromJson(filePath: string): Promise<TransferStats> {
    console.log("\n" + "=".repeat(60));
    console.log("[START] Langfuse Prompt Import");
    console.log("=".repeat(60) + "\n");

    if (this.dryRun) {
      this.log("DRY RUN MODE - No changes will be made\n", "warning");
    }

    // Read and parse JSON file
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, "utf-8");
    let exportData: PromptsExport;

    try {
      exportData = JSON.parse(fileContent);
    } catch {
      throw new Error(`Invalid JSON in file: ${filePath}`);
    }

    // Validate structure
    if (!exportData.prompts || !Array.isArray(exportData.prompts)) {
      throw new Error("Invalid export file: missing 'prompts' array");
    }

    this.log(`Import file: ${filePath}`);
    this.log(`Exported at: ${exportData.exportedAt || "unknown"}`);
    this.log(`Source: ${exportData.sourceBaseUrl || "unknown"}`);
    this.log(`Prompts: ${exportData.prompts.length}\n`);

    await this.testDestConnection();
    console.log();

    // Import each prompt
    for (const prompt of exportData.prompts) {
      this.stats.total++;
      console.log(`${"─".repeat(50)}`);
      this.log(`Importing: ${prompt.name}`);
      this.log(`  Type: ${prompt.type}`);
      if (prompt.labels && prompt.labels.length > 0) {
        this.log(`  Labels: ${prompt.labels.join(", ")}`);
      }

      if (this.dryRun) {
        this.log(`  [DRY RUN] Would create prompt`, "skip");
        this.stats.transferred++;
        continue;
      }

      try {
        // Prompt from JSON is already a CreatePromptRequest
        await this.createPromptInDest(prompt);
        this.stats.transferred++;
      } catch (error) {
        this.stats.failed++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.stats.errors.push({ name: prompt.name, error: errorMessage });
        this.log(`  Failed: ${errorMessage}`, "error");
      }
    }

    this.printSummary();
    return this.stats;
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  // Handle help flag
  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  // Validate configuration based on mode
  const missingVars: string[] = [];

  if (config.mode === "export") {
    // Export mode only needs source credentials
    if (!config.source.publicKey) missingVars.push("SOURCE_LANGFUSE_PUBLIC_KEY");
    if (!config.source.secretKey) missingVars.push("SOURCE_LANGFUSE_SECRET_KEY");
  } else if (config.mode === "import") {
    // Import mode only needs destination credentials
    if (!config.dest.publicKey) missingVars.push("DEST_LANGFUSE_PUBLIC_KEY");
    if (!config.dest.secretKey) missingVars.push("DEST_LANGFUSE_SECRET_KEY");
    if (!config.dest.baseUrl) missingVars.push("DEST_LANGFUSE_BASE_URL");
  } else {
    // Transfer mode needs both
    if (!config.source.publicKey) missingVars.push("SOURCE_LANGFUSE_PUBLIC_KEY");
    if (!config.source.secretKey) missingVars.push("SOURCE_LANGFUSE_SECRET_KEY");
    if (!config.dest.publicKey) missingVars.push("DEST_LANGFUSE_PUBLIC_KEY");
    if (!config.dest.secretKey) missingVars.push("DEST_LANGFUSE_SECRET_KEY");
    if (!config.dest.baseUrl) missingVars.push("DEST_LANGFUSE_BASE_URL");
  }

  if (missingVars.length > 0) {
    console.error("[ERROR] Missing required environment variables:");
    console.error(`   ${missingVars.join("\n   ")}`);
    console.error(`\nRun with --help for usage information.`);
    process.exit(1);
  }

  // Create clients (only create what's needed for the mode)
  const sourceClient = new LangfuseClient(
    config.source.publicKey,
    config.source.secretKey,
    config.source.baseUrl
  );

  const destClient = new LangfuseClient(
    config.dest.publicKey,
    config.dest.secretKey,
    config.dest.baseUrl
  );

  // Create transfer instance
  const transfer = new PromptTransfer(sourceClient, destClient, {
    dryRun: config.dryRun,
    transferAllVersions: config.transferAllVersions,
  });

  try {
    if (config.mode === "export") {
      await transfer.exportToJson(config.jsonFile);
      process.exit(0);
    } else if (config.mode === "import") {
      const stats = await transfer.importFromJson(config.jsonFile);
      process.exit(stats.failed > 0 ? 1 : 0);
    } else {
      const stats = await transfer.transferAll();
      process.exit(stats.failed > 0 ? 1 : 0);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n[ERROR] ${config.mode} failed: ${errorMessage}`);
    process.exit(1);
  }
}

// Run if executed directly
main().catch(console.error);

// Export for use as a module
export { LangfuseClient, PromptTransfer };
export type {
  Config,
  PromptMeta,
  PromptData,
  ChatMessage,
  CreatePromptRequest,
  TransferStats,
  TransferOptions,
  PromptsExport,
};
