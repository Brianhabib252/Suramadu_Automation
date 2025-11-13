/**
 * CLI entry point for the Suramadu automation runner.
 * - Parses CLI flags to determine dry-run, demo, or live execution.
 * - Spins up Playwright via BrowserTools when running real workflows.
 * - Renders themed output panels and status updates for the operator.
 * - Bridges YAML task files with the lower-level DSL runner.
 */
import 'dotenv/config';
import path from 'node:path';
import {
  describeTaskPlan,
  loadTaskFile,
  resolveDisplayStepCount,
  runTask,
} from './dsl/runner';
import { BrowserTools } from './lib/browserTools';
import {
  defaultCliTheme,
  formatDuration,
  wrapPlainText,
} from './lib/cliTheme';
import { nowJakarta } from './lib/time';

const cli = defaultCliTheme;
const PANEL_TEXT_WIDTH = 44;
const COMPLETION_ASCII = [
  '  _________  __  ______  __   ______________',
  ' / ___/ __ \\/  |/  / _ \\/ /  / __/_  __/ __/',
  '/ /__/ /_/ / /|_/ / ___/ /__/ _/  / / / _/  ',
  '\\___/\\____/_/  /_/_/  /____/___/ /_/ /___/  ',
  '                                            ',
  '                                            ',
  '                                            ',
];
const TIMEOUT_ASCII = [
  '  ___ ___ ___  ___  ___ ',
  ' | __| _ \\ _ \\/ _ \\| _ \\',
  ' | _||   /   / (_) |   /',
  ' |___|_|_\\_|_\\\\___/|_|_\\',
  '                        ',
];

interface CliOptions {
  taskPath?: string;
  dryRun: boolean;
  headless: boolean;
  retries: number;
  browserChannel?: string;
  slowMoMs?: number;
}

/**
 * Parse CLI arguments into strongly typed options, applying defaults and
 * ignoring unexpected flags rather than exiting early.
 */
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
      console.warn(
        cli.formatStatus(`Ignoring unexpected argument "${arg}"`, 'warning'),
      );
    }
  }

  return options;
}

function createRunId(): string {
  const datePart = nowJakarta('yyyyMMdd');
  const timePart = nowJakarta('HHmmss');
  const random = Math.random().toString(36).slice(-4);
  return `${datePart}_Runs_${timePart}_${random}`;
}

/**
 * Run a minimal screenshot demo when the CLI is invoked without a task file.
 */
async function runDemo(): Promise<void> {
  const tools = await BrowserTools.launch({
    artifactsDir: path.resolve(process.cwd(), 'artifacts'),
    headless: true,
    browserChannel: undefined,
  });

  try {
    await tools.navigate('https://example.com', 'networkidle');
    await tools.screenshot('demo.png');
    console.log(cli.formatStatus('Demo scenario captured demo.png', 'success'));
  } finally {
    await tools.close();
  }
}

/**
 * Render the planned step list for a task file without touching the browser.
 */
async function runDry(taskPath: string): Promise<void> {
  const { task, filePath } = await loadTaskFile(taskPath);
  const displayName = task.name ?? filePath;
  const headerLines = cli.formatBox([
    `${cli.symbols.info} ${cli.heading('Dry Run')}`,
    `${cli.symbols.pointer} ${cli.label(displayName)}`,
    `${cli.symbols.bullet} ${cli.muted(
      `${task.steps.length} planned step${task.steps.length === 1 ? '' : 's'}`,
    )}`,
  ]);
  console.log('');
  headerLines.forEach((line) => console.log(line));
  describeTaskPlan(task).forEach((rawLine, index) => {
    const match = /^\[\d+\]\s*(.*)$/.exec(rawLine);
    const description = match?.[1] ?? rawLine;
    const stepNumber = String(index + 1).padStart(2, '0');
    const segments = wrapPlainText(description, PANEL_TEXT_WIDTH);
    if (segments.length === 0) {
      console.log(
        `${cli.symbols.pointer} ${cli.muted(`#${stepNumber}`)} ${cli.label(
          description,
        )}`,
      );
      return;
    }
    console.log(
      `${cli.symbols.pointer} ${cli.muted(`#${stepNumber}`)} ${cli.label(
        segments[0],
      )}`,
    );
    segments.slice(1).forEach((segment) => {
      console.log(`  ${cli.label(segment)}`);
    });
  });
}

/**
 * Execute a YAML-defined task end-to-end, setting up run-specific artifacts
 * and rendering a themed summary before and after the browser workflow.
 */
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

  const totalSteps = resolveDisplayStepCount(task.steps.length);
  const displayName = task.name ?? filePath;
  const metadataParts = [
    options.headless ? 'Headless' : 'Headful',
    options.browserChannel ? `channel:${options.browserChannel}` : undefined,
    options.retries ? `retries:${options.retries}` : undefined,
    options.slowMoMs ? `slowmo:${options.slowMoMs}ms` : undefined,
  ].filter((part): part is string => Boolean(part));
  const runIdSegments = wrapPlainText(runId, PANEL_TEXT_WIDTH);
  const metadataSegments = wrapMetadata(metadataParts, PANEL_TEXT_WIDTH);
  const headerLines: string[] = [
    `${cli.symbols.step} ${cli.heading('Automation Run')}`,
    `${cli.symbols.pointer} ${cli.label(displayName)}`,
  ];
  if (runIdSegments.length === 0) {
    headerLines.push(`${cli.symbols.info} ${cli.muted(`Run ${runId}`)}`);
  } else {
    headerLines.push(`${cli.symbols.info} ${cli.muted('Run')}`);
    runIdSegments.forEach((segment) => {
      headerLines.push(`  ${cli.muted(segment)}`);
    });
  }
  headerLines.push(
    `${cli.symbols.bullet} ${cli.muted(
      `${totalSteps} step${totalSteps === 1 ? '' : 's'}`,
    )}`,
  );
  if (metadataSegments.length > 0) {
    headerLines.push(`${cli.symbols.pointer} ${cli.muted(metadataSegments[0])}`);
    metadataSegments.slice(1).forEach((segment) => {
      headerLines.push(`  ${cli.muted(segment)}`);
    });
  }
  console.log('');
  cli.formatBox(headerLines).forEach((line) => console.log(line));

  const runStarted = process.hrtime.bigint();
  try {
    const outcome = await runTask(tools, task, {
      runId,
      artifactsDir: runArtifactsDir,
      retries: options.retries,
    });
    const elapsedMs =
      Number(process.hrtime.bigint() - runStarted) / 1_000_000;
    const statusTone = outcome.timeoutWarnings ? 'warning' : 'success';
    const statusMessage = outcome.timeoutWarnings
      ? `Run ${runId} selesai dengan peringatan timeout dalam ${formatDuration(elapsedMs)}`
      : `Run ${runId} completed in ${formatDuration(elapsedMs)}`;
    console.log(
      cli.formatStatus(
        statusMessage,
        statusTone,
      ),
    );
    if (!outcome.timeoutWarnings) {
      for (const line of COMPLETION_ASCII) {
        console.log(cli.success(line));
      }
    }
  } finally {
    await tools.close();
  }
}

/**
 * Greedily wrap metadata strings so they fit within the panel width used by
 * the CLI header (e.g. retries, channel, slow motion, run id).
 */
function wrapMetadata(parts: string[], limit: number): string[] {
  if (parts.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = '';
  for (const part of parts) {
    if (!current) {
      current = part;
      continue;
    }
    const candidate = `${current} | ${part}`;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      lines.push(current);
      current = part;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
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
  const message =
    (error && typeof error === 'object' && 'message' in error
      ? (error as { message?: string }).message
      : undefined) ?? (error !== undefined ? String(error) : 'Unknown error');
  console.error(cli.formatStatus(`Automation failed: ${message}`, 'error'));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  } else if (error !== undefined) {
    console.error(error);
  }
  const combinedText = [
    message ?? '',
    error instanceof Error && error.stack ? error.stack : '',
    error !== undefined && !(error instanceof Error) ? String(error) : '',
  ]
    .join(' ')
    .toLowerCase();
  if (
    combinedText.includes('timeout') ||
    combinedText.includes('timed out') ||
    combinedText.includes('time out')
  ) {
    for (const line of TIMEOUT_ASCII) {
      console.error(cli.error(line));
    }
  }
  process.exitCode = 1;
});
