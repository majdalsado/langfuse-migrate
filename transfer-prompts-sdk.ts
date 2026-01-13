/**
 * Langfuse Prompt Transfer - TypeScript SDK Version
 * 
 * This version uses the official @langfuse/client SDK.
 * 
 * Installation:
 *   npm install @langfuse/client typescript ts-node
 * 
 * Usage:
 *   npx ts-node transfer-prompts-sdk.ts
 */

import { LangfuseClient } from '@langfuse/client';

// Types
interface PromptMeta {
  name: string;
  versions: number[];
  labels: string[];
  tags: string[];
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

// Configuration from environment
const config = {
  source: {
    publicKey: process.env.SOURCE_LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.SOURCE_LANGFUSE_SECRET_KEY!,
    baseUrl: process.env.SOURCE_LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com',
  },
  dest: {
    publicKey: process.env.DEST_LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.DEST_LANGFUSE_SECRET_KEY!,
    baseUrl: process.env.DEST_LANGFUSE_BASE_URL!,
  },
  transferAllVersions: process.env.TRANSFER_ALL_VERSIONS === 'true',
  dryRun: process.env.DRY_RUN === 'true',
};

/**
 * Prompt Transfer using official Langfuse SDK
 */
class PromptTransferSDK {
  private sourceClient: LangfuseClient;
  private destClient: LangfuseClient;
  private options: TransferOptions;
  private stats: TransferStats = {
    total: 0,
    transferred: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  constructor(
    sourceConfig: { publicKey: string; secretKey: string; baseUrl: string },
    destConfig: { publicKey: string; secretKey: string; baseUrl: string },
    options: TransferOptions = {}
  ) {
    // Initialize source client
    this.sourceClient = new LangfuseClient({
      publicKey: sourceConfig.publicKey,
      secretKey: sourceConfig.secretKey,
      baseUrl: sourceConfig.baseUrl,
    });

    // Initialize destination client
    this.destClient = new LangfuseClient({
      publicKey: destConfig.publicKey,
      secretKey: destConfig.secretKey,
      baseUrl: destConfig.baseUrl,
    });

    this.options = options;
  }

  private log(message: string, type: 'info' | 'success' | 'warning' | 'error' | 'skip' = 'info') {
    const prefix = {
      info: '📋',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      skip: '⏭️',
    }[type];
    console.log(`${prefix} ${message}`);
  }

  /**
   * Get all prompts from the source instance
   */
  private async getAllSourcePrompts(): Promise<PromptMeta[]> {
    const allPrompts: PromptMeta[] = [];
    let page = 1;
    const limit = 100;

    while (true) {
      // Use the API property to access raw API methods
      const response = await this.sourceClient.api.prompts.list({
        page,
        limit,
      });

      const prompts = response.data || [];
      allPrompts.push(...prompts);

      const totalPages = response.meta?.totalPages || 1;
      if (page >= totalPages || prompts.length === 0) {
        break;
      }
      page++;
    }

    return allPrompts;
  }

  /**
   * Transfer all prompts
   */
  async transferAll(): Promise<TransferStats> {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 Langfuse Prompt Transfer Tool (SDK Version)');
    console.log('='.repeat(60) + '\n');

    if (this.options.dryRun) {
      this.log('DRY RUN MODE - No changes will be made\n', 'warning');
    }

    // Fetch all prompts from source
    this.log('Fetching prompts from source instance...\n');
    const sourcePrompts = await this.getAllSourcePrompts();

    if (sourcePrompts.length === 0) {
      this.log('No prompts found in source instance', 'warning');
      return this.stats;
    }

    this.log(`Found ${sourcePrompts.length} prompt(s) in source instance\n`);

    // Process each prompt
    for (const promptMeta of sourcePrompts) {
      await this.transferPrompt(promptMeta);
    }

    this.printSummary();
    return this.stats;
  }

  /**
   * Transfer a single prompt
   */
  private async transferPrompt(promptMeta: PromptMeta): Promise<void> {
    const { name, versions = [], labels = [] } = promptMeta;
    this.stats.total++;

    console.log(`\n${'─'.repeat(50)}`);
    this.log(`Processing: ${name}`);
    this.log(`  Versions: ${versions.length}, Labels: ${labels.join(', ') || 'none'}`);

    try {
      // Determine which versions to transfer
      let versionsToTransfer: number[];
      if (this.options.transferAllVersions) {
        versionsToTransfer = [...versions].sort((a, b) => a - b);
      } else {
        versionsToTransfer = [Math.max(...versions)];
      }

      for (const version of versionsToTransfer) {
        await this.transferPromptVersion(name, version);
      }

      this.stats.transferred++;
      this.log(`Successfully transferred: ${name}`, 'success');
    } catch (error: any) {
      this.stats.failed++;
      this.stats.errors.push({ name, error: error.message });
      this.log(`Failed to transfer ${name}: ${error.message}`, 'error');
    }
  }

  /**
   * Transfer a specific version of a prompt
   */
  private async transferPromptVersion(name: string, version: number): Promise<void> {
    this.log(`  Fetching version ${version}...`);

    // Fetch the prompt using the SDK
    const prompt = await this.sourceClient.prompt.get(name, { version });

    this.log(`  Type: ${prompt.type}`);
    this.log(`  Labels: ${prompt.labels.filter(l => l !== 'latest').join(', ') || 'none'}`);

    if (prompt.type === 'text') {
      const preview = typeof prompt.prompt === 'string' 
        ? prompt.prompt.substring(0, 80) 
        : '';
      this.log(`  Prompt: "${preview}..."`);
    } else {
      const msgCount = Array.isArray(prompt.prompt) ? prompt.prompt.length : 0;
      this.log(`  Prompt: ${msgCount} message(s)`);
    }

    if (this.options.dryRun) {
      this.log(`  [DRY RUN] Would create prompt version`, 'skip');
      return;
    }

    // Create the prompt in destination
    const createOptions: any = {
      name: prompt.name,
      type: prompt.type,
      prompt: prompt.prompt,
    };

    if (prompt.config && Object.keys(prompt.config).length > 0) {
      createOptions.config = prompt.config;
    }

    if (prompt.labels && prompt.labels.length > 0) {
      createOptions.labels = prompt.labels.filter(l => l !== 'latest');
    }

    if (prompt.tags && prompt.tags.length > 0) {
      createOptions.tags = prompt.tags;
    }

    const result = await this.destClient.prompt.create(createOptions);
    this.log(`  Created version ${result.version} in destination`, 'success');
  }

  /**
   * Print transfer summary
   */
  private printSummary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 Transfer Summary');
    console.log('='.repeat(60));
    console.log(`  Total prompts:       ${this.stats.total}`);
    console.log(`  Transferred:         ${this.stats.transferred}`);
    console.log(`  Skipped:             ${this.stats.skipped}`);
    console.log(`  Failed:              ${this.stats.failed}`);

    if (this.stats.errors.length > 0) {
      console.log('\n❌ Errors:');
      for (const { name, error } of this.stats.errors) {
        console.log(`  - ${name}: ${error}`);
      }
    }

    if (this.options.dryRun) {
      console.log('\n⚠️  This was a DRY RUN - no changes were made');
    }

    console.log('='.repeat(60) + '\n');
  }
}

// Main execution
async function main() {
  // Validate configuration
  const missingVars: string[] = [];
  if (!config.source.publicKey) missingVars.push('SOURCE_LANGFUSE_PUBLIC_KEY');
  if (!config.source.secretKey) missingVars.push('SOURCE_LANGFUSE_SECRET_KEY');
  if (!config.dest.publicKey) missingVars.push('DEST_LANGFUSE_PUBLIC_KEY');
  if (!config.dest.secretKey) missingVars.push('DEST_LANGFUSE_SECRET_KEY');
  if (!config.dest.baseUrl) missingVars.push('DEST_LANGFUSE_BASE_URL');

  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    console.error(`   ${missingVars.join('\n   ')}`);
    process.exit(1);
  }

  const transfer = new PromptTransferSDK(
    config.source,
    config.dest,
    {
      dryRun: config.dryRun,
      transferAllVersions: config.transferAllVersions,
    }
  );

  try {
    const stats = await transfer.transferAll();
    process.exit(stats.failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n❌ Transfer failed: ${error.message}`);
    process.exit(1);
  }
}

main();
