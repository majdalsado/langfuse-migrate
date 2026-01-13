#!/usr/bin/env npx ts-node

/**
 * Langfuse Prompt Transfer Tool
 *
 * Transfers all prompts from one Langfuse instance (e.g., US Cloud)
 * to another instance (e.g., private self-hosted).
 *
 * Usage:
 *   npx ts-node transfer-prompts.ts
 *
 */

import * as https from "https";
import * as http from "http";
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
  transferAllVersions: process.env.TRANSFER_ALL_VERSIONS === "true",
  dryRun: process.env.DRY_RUN === "true",
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
   */
  async getPrompt(
    name: string,
    options: { version?: number; label?: string } = {}
  ): Promise<PromptData> {
    // URL encode the prompt name (handles folders like "folder/prompt-name")
    const encodedName = encodeURIComponent(name);
    const params = new URLSearchParams();

    if (options.version !== undefined)
      params.set("version", options.version.toString());
    if (options.label) params.set("label", options.label);

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

    // Fetch the full prompt data
    const promptData = await this.source.getPrompt(name, { version });

    // Prepare the create request
    const createRequest: CreatePromptRequest = {
      name: promptData.name,
      type: promptData.type,
      prompt: promptData.prompt,
    };

    // Add optional fields if present
    if (promptData.config && Object.keys(promptData.config).length > 0) {
      createRequest.config = promptData.config;
    }

    if (promptData.labels && promptData.labels.length > 0) {
      // Filter out 'latest' as it's managed by Langfuse
      createRequest.labels = promptData.labels.filter((l) => l !== "latest");
    }

    if (promptData.tags && promptData.tags.length > 0) {
      createRequest.tags = promptData.tags;
    }

    // Log the prompt being transferred
    this.log(`  Type: ${promptData.type}`);
    if (createRequest.labels && createRequest.labels.length > 0) {
      this.log(`  Labels: ${createRequest.labels.join(", ")}`);
    }
    if (createRequest.tags && createRequest.tags.length > 0) {
      this.log(`  Tags: ${createRequest.tags.join(", ")}`);
    }
    if (createRequest.config) {
      this.log(
        `  Config: ${JSON.stringify(createRequest.config).substring(0, 100)}...`
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

    if (this.dryRun) {
      this.log(`  [DRY RUN] Would create prompt version`, "skip");
      return;
    }

    // Create the prompt in destination
    try {
      const result = await this.dest.createPrompt(createRequest);
      this.log(`  Created version ${result.version} in destination`, "success");
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
      } else {
        throw error;
      }
    }
  }

  /**
   * Test connections to both instances
   */
  private async testConnections(): Promise<void> {
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
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  // Validate configuration
  const missingVars: string[] = [];

  if (!config.source.publicKey) missingVars.push("SOURCE_LANGFUSE_PUBLIC_KEY");
  if (!config.source.secretKey) missingVars.push("SOURCE_LANGFUSE_SECRET_KEY");
  if (!config.dest.publicKey) missingVars.push("DEST_LANGFUSE_PUBLIC_KEY");
  if (!config.dest.secretKey) missingVars.push("DEST_LANGFUSE_SECRET_KEY");
  if (!config.dest.baseUrl) missingVars.push("DEST_LANGFUSE_BASE_URL");

  if (missingVars.length > 0) {
    console.error("[ERROR] Missing required environment variables:");
    console.error(`   ${missingVars.join("\n   ")}`);
    console.error("\nUsage:");
    console.error("  SOURCE_LANGFUSE_PUBLIC_KEY=pk-lf-... \\");
    console.error("  SOURCE_LANGFUSE_SECRET_KEY=sk-lf-... \\");
    console.error(
      "  SOURCE_LANGFUSE_BASE_URL=https://us.cloud.langfuse.com \\"
    );
    console.error("  DEST_LANGFUSE_PUBLIC_KEY=pk-lf-... \\");
    console.error("  DEST_LANGFUSE_SECRET_KEY=sk-lf-... \\");
    console.error(
      "  DEST_LANGFUSE_BASE_URL=https://your-private-instance.com \\"
    );
    console.error("  npx ts-node transfer-prompts.ts");
    process.exit(1);
  }

  // Create clients
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

  // Run transfer
  const transfer = new PromptTransfer(sourceClient, destClient, {
    dryRun: config.dryRun,
    transferAllVersions: config.transferAllVersions,
  });

  try {
    const stats = await transfer.transferAll();
    process.exit(stats.failed > 0 ? 1 : 0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n[ERROR] Transfer failed: ${errorMessage}`);
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
};
