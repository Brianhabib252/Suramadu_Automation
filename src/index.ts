import 'dotenv/config';
import path from 'node:path';
import { describeTaskPlan, loadTaskFile, runTask } from './dsl/runner';
import { BrowserTools } from './lib/browserTools';

interface CliOptions {
  taskPath?: string;
  dryRun: boolean;
  headless: boolean;
  retries: number;
  browserChannel?: string;
  slowMoMs?: number;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    headless: true,
    retries: 1,
    taskPath: undefined,
    browserChannel: undefined,
    slowMoMs: undefined,
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--headful') {
      options.headless = false;
    } else if (arg === '--headless') {
      options.headless = true;
    } else if (arg === '--chrome') {
      options.headless = false;
      options.browserChannel = 'chrome';
    } else if (arg.startsWith('--retries=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (!Number.isNaN(value) && value >= 0) {
        options.retries = value;
      }
    } else if (arg.startsWith('--browser=')) {
      const channel = arg.split('=')[1];
      if (channel) {
        options.browserChannel = channel;
      }
    } else if (arg.startsWith('--slowmo=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (!Number.isNaN(value) && value >= 0) {
        options.slowMoMs = value;
      }
    } else if (!options.taskPath) {
      options.taskPath = arg;
    } else {
      console.warn(`Ignoring unexpected argument "${arg}"`);
    }
  }

  return options;
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(-4);
  return `run-${timestamp}-${random}`;
}

async function runDemo(): Promise<void> {
  const tools = await BrowserTools.launch({
    artifactsDir: path.resolve(process.cwd(), 'artifacts'),
    headless: true,
    browserChannel: undefined,
  });

  try {
    await tools.navigate('https://example.com', 'networkidle');
    await tools.screenshot('demo.png');
    console.log('OK scaffold');
  } finally {
    await tools.close();
  }
}

async function runDry(taskPath: string): Promise<void> {
  const { task, filePath } = await loadTaskFile(taskPath);
  console.log(`[dry-run] Task "${task.name ?? filePath}"`);
  for (const line of describeTaskPlan(task)) {
    console.log(`  ${line}`);
  }
}

async function runFromDsl(options: CliOptions): Promise<void> {
  if (!options.taskPath) {
    throw new Error('Task path is required');
  }

  const { task, filePath } = await loadTaskFile(options.taskPath);
  const runId = createRunId();
  const baseArtifactsDir = path.resolve(process.cwd(), 'artifacts');
  const runArtifactsDir = path.join(baseArtifactsDir, 'runs', runId);

  const tools = await BrowserTools.launch({
    artifactsDir: runArtifactsDir,
    headless: options.headless,
    browserChannel: options.browserChannel,
    slowMoMs: options.slowMoMs,
  });

  console.log(
    `Running task "${task.name ?? filePath}" (runId=${runId}) with ${
      task.steps.length
    } steps...`,
  );

  try {
    await runTask(tools, task, {
      runId,
      artifactsDir: runArtifactsDir,
      retries: options.retries,
    });
    console.log(`Task completed (runId=${runId})`);
  } finally {
    await tools.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.taskPath) {
    if (options.dryRun) {
      throw new Error('Dry-run mode requires a task path.');
    }
    await runDemo();
    return;
  }

  if (options.dryRun) {
    await runDry(options.taskPath);
    return;
  }

  await runFromDsl(options);
}

main().catch((error) => {
  console.error('Automation failed:', error);
  process.exitCode = 1;
});
