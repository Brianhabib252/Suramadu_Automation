import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locator } from 'playwright';
import { parse } from 'yaml';
import { BrowserTools } from '../lib/browserTools';
import type { LoadState } from '../lib/browserTools';
import { extractNews, type NewsExtractionResult } from '../lib/newsExtract';
import { aiEvaluate, type AiEvaluationResult } from '../lib/policyLLM';
import {
  ArtifactStep,
  AssertStep,
  ClickStep,
  ExtractNewsStep,
  AiEvaluateStep,
  DecisionApplyStep,
  BreakIfStep,
  ForEachStep,
  InRowClickStep,
  WhileSelectorStep,
  NavigateStep,
  Step,
  TaskDefinition,
  TypeStep,
  WaitForStep,
  validateTaskDefinition,
} from './schema';

export interface LoadTaskResult {
  task: TaskDefinition;
  filePath: string;
}

export async function loadTaskFile(filePath: string): Promise<LoadTaskResult> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  const fileContents = await fs.readFile(absolutePath, 'utf-8');
  const parsed = parse(fileContents);
  const task = validateTaskDefinition(parsed, absolutePath);
  return { task, filePath: absolutePath };
}

export function describeTaskPlan(task: TaskDefinition): string[] {
  return task.steps.map((step, index) => {
    return `[${index + 1}] ${describeStep(step)}`;
  });
}

export interface RunTaskOptions {
  runId?: string;
  artifactsDir?: string;
  retries?: number;
}

export async function runTask(
  tools: BrowserTools,
  task: TaskDefinition,
  options: RunTaskOptions = {},
): Promise<void> {
  const env = process.env;
  const runArtifactsDir = options.artifactsDir ?? tools.getArtifactsDir();
  const state: RunnerState = {
    runId: options.runId,
    runArtifactsDir,
    currentItemDir: undefined,
    shouldHalt: false,
  };
  const maxRetries = options.retries ?? 1;

  const total = task.steps.length;
  for (const [index, step] of task.steps.entries()) {
    const label = describeStep(step);
    logStepBanner(index + 1, total, label);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await executeStep(step, {
          tools,
          env,
          state,
          depth: 0,
        });
        break;
      } catch (error) {
        if (attempt >= maxRetries || !shouldRetryError(error)) {
          throw error;
        }
        attempt += 1;
        console.warn(
          `Retrying step "${label}" (attempt ${attempt + 1}/${maxRetries + 1}) due to:`,
          error,
        );
      }
    }
    if (state.shouldHalt) {
      logDetail(0, 'break condition met; halting remaining steps.');
      return;
    }
  }
}

interface RunnerState {
  runId?: string;
  runArtifactsDir: string;
  currentItemDir?: string;
  shouldHalt?: boolean;
  lastExtract?: NewsExtractionResult;
  lastAi?: AiEvaluationResult;
}

interface StepContext {
  tools: BrowserTools;
  env: NodeJS.ProcessEnv;
  row?: Locator;
  state: RunnerState;
  depth: number;
}

async function executeStep(
  step: Step,
  context: StepContext,
): Promise<void> {
  const resolvedStep = resolveStepPlaceholders(step, context.env, context.state);

  switch (resolvedStep.type) {
    case 'navigate':
      await runNavigateStep(context.tools, resolvedStep);
      return;
    case 'type':
      await runTypeStep(context.tools, resolvedStep);
      return;
    case 'click':
      await runClickStep(context.tools, resolvedStep);
      return;
    case 'wait_for':
      await runWaitForStep(context.tools, resolvedStep);
      return;
    case 'assert':
      await runAssertStep(context.tools, resolvedStep);
      return;
    case 'artifact':
      await runArtifactStep(context, resolvedStep);
      return;
    case 'extract_news':
      await runExtractNewsStep(context, resolvedStep);
      return;
    case 'ai_evaluate':
      await runAiEvaluateStep(context);
      return;
    case 'decision_apply':
      await runDecisionApplyStep(context, resolvedStep);
      return;
    case 'break_if':
      await runBreakIfStep(context, resolvedStep);
      return;
    case 'foreach':
      await runForEachStep(resolvedStep, context);
      return;
    case 'while_selector':
      await runWhileSelectorStep(resolvedStep, context);
      return;
    case 'in_row_click':
      await runInRowClickStep(context, resolvedStep);
      return;
    default: {
      const neverStep: never = resolvedStep;
      throw new Error(`Unsupported step: ${JSON.stringify(neverStep)}`);
    }
  }
}

function describeStep(step: Step): string {
  if (step.type === 'navigate') {
    return `navigate to ${step.url}`;
  }

  if (step.type === 'type') {
    return `type into ${step.selector}`;
  }

  if (step.type === 'click') {
    return `click ${step.selector}`;
  }

  if (step.type === 'wait_for') {
    const parts = [];
    if (step.selector) {
      parts.push(`selector ${step.selector}`);
    }
    if (step.state) {
      parts.push(`state ${step.state}`);
    }
    return `wait_for ${parts.join(' & ')}`;
  }

  if (step.type === 'assert') {
    if (step.assert === 'contains_text') {
      return `assert ${step.selector} contains "${truncate(step.value)}"`;
    }
    return `assert ${step.selector} is empty`;
  }

  if (step.type === 'artifact') {
    return `capture ${step.artifact}${step.path ? ` -> ${step.path}` : ''}`;
  }

  if (step.type === 'foreach') {
    return `foreach ${step.selector}`;
  }

  if (step.type === 'while_selector') {
    return `while_selector ${step.selector}`;
  }

  if (step.type === 'in_row_click') {
    return `in_row_click ${step.selector}`;
  }

  if (step.type === 'extract_news') {
    return `extract_news${step.path ? ` -> ${step.path}` : ''}`;
  }

  if (step.type === 'ai_evaluate') {
    return 'ai_evaluate';
  }

  if (step.type === 'decision_apply') {
    return `decision_apply ${step.decision_source}`;
  }

  if (step.type === 'break_if') {
    return `break_if ${step.condition} ${step.selector}`;
  }

  return `unsupported step ${(step as { type: string }).type}`;
}

function truncate(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function resolveStepPlaceholders<T extends Step>(
  step: T,
  env: NodeJS.ProcessEnv,
  state: RunnerState,
): T {
  switch (step.type) {
    case 'navigate':
      return {
        ...step,
        url: resolveString(step.url, env, state),
      };
    case 'type':
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
        value: resolveString(step.value, env, state),
      };
    case 'click':
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
      };
    case 'wait_for':
      return {
        ...step,
        selector:
          step.selector !== undefined
            ? resolveString(step.selector, env, state)
            : undefined,
      };
    case 'assert':
      if (step.assert === 'contains_text') {
        return {
          ...step,
          selector: resolveString(step.selector, env, state),
          value: resolveString(step.value, env, state),
        };
      }
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
      };
    case 'artifact':
      return {
        ...step,
        path: step.path ? resolveString(step.path, env, state) : undefined,
      };
    case 'extract_news':
      return {
        ...step,
        path: step.path ? resolveString(step.path, env, state) : undefined,
      };
    case 'ai_evaluate':
      return step;
    case 'decision_apply':
      return {
        ...step,
        ok_selector: resolveString(step.ok_selector, env, state),
        reject_selector: resolveString(step.reject_selector, env, state),
        reason_selector: step.reason_selector
          ? resolveString(step.reason_selector, env, state)
          : step.reason_selector,
        submit_selector: resolveString(step.submit_selector, env, state),
        confirm_selector: step.confirm_selector
          ? resolveString(step.confirm_selector, env, state)
          : step.confirm_selector,
        decision_source: resolveString(step.decision_source, env, state),
        reason_source: step.reason_source
          ? resolveString(step.reason_source, env, state)
          : undefined,
        post_wait_state:
          typeof step.post_wait_state === 'string'
            ? (resolveString(step.post_wait_state, env, state) as
                | LoadState
                | 'skip')
            : step.post_wait_state,
      };
    case 'break_if':
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
      };
    case 'foreach':
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
      };
    case 'while_selector':
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
      };
    case 'in_row_click':
      return {
        ...step,
        selector: resolveString(step.selector, env, state),
      };
    default:
      return step;
  }
}

function resolveString(
  value: string,
  env: NodeJS.ProcessEnv,
  state: RunnerState,
): string {
  let resolved = value.replace(
    /\{\{\s*env\.([A-Za-z0-9_]+)\s*}}/g,
    (_, key: string) => {
      const envValue = env[key];
      if (envValue === undefined) {
        throw new Error(`Missing environment variable "${key}"`);
      }
      return envValue;
    },
  );

  resolved = resolved.replace(
    /\{\{\s*ai\.([A-Za-z0-9_]+)\s*}}/g,
    (_, key: string) => {
      const ai = state.lastAi;
      if (!ai) {
        throw new Error(`AI result not available for placeholder "ai.${key}"`);
      }
      const aiRecord = ai as unknown as Record<string, unknown>;
      if (!(key in aiRecord)) {
        return '';
      }
      const valueRaw = aiRecord[key];
      if (valueRaw === undefined || valueRaw === null) {
        return '';
      }
      return stringifyPlaceholderValue(valueRaw);
    },
  );

  resolved = resolved.replace(
    /\{\{\s*extract\.([A-Za-z0-9_]+)\s*}}/g,
    (_, key: string) => {
      const extract = state.lastExtract;
      if (!extract) {
        throw new Error(
          `Extraction data not available for placeholder "extract.${key}"`,
        );
      }
      const extractRecord = extract as unknown as Record<string, unknown>;
      if (!(key in extractRecord)) {
        throw new Error(`Extraction data missing property "${key}"`);
      }
      const valueRaw = extractRecord[key];
      if (valueRaw === undefined || valueRaw === null) {
        throw new Error(`Extraction data missing property "${key}"`);
      }
      return stringifyPlaceholderValue(valueRaw);
    },
  );

  return resolved;
}

function stringifyPlaceholderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyPlaceholderValue(item)).join('\n');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  throw new Error('Unsupported placeholder value type');
}

async function runNavigateStep(
  tools: BrowserTools,
  step: NavigateStep,
): Promise<void> {
  await tools.navigate(step.url, step.wait_until ?? 'load', step.timeout_ms);
}

async function runTypeStep(
  tools: BrowserTools,
  step: TypeStep,
): Promise<void> {
  await tools.type(step.selector, step.value, step.mode);
}

async function runClickStep(
  tools: BrowserTools,
  step: ClickStep,
): Promise<void> {
  await tools.click(step.selector);
}

async function runWaitForStep(
  tools: BrowserTools,
  step: WaitForStep,
): Promise<void> {
  await tools.waitFor({
    selector: step.selector,
    state: step.state,
    timeoutMs: step.timeout_ms,
  });
}

async function runAssertStep(
  tools: BrowserTools,
  step: AssertStep,
): Promise<void> {
  if (step.assert === 'contains_text') {
    const text = await tools.extractText(step.selector);
    if (!text.includes(step.value)) {
      throw new Error(
        `Assert failed: selector "${step.selector}" did not contain "${step.value}". Actual text: "${text}"`,
      );
    }
    return;
  }

  if (step.assert === 'empty_selector') {
    const count = await tools.count(step.selector);
    if (count > 0) {
      throw new Error(
        `Assert failed: selector "${step.selector}" matched ${count} elements`,
      );
    }
    return;
  }
}

async function runArtifactStep(
  context: StepContext,
  step: ArtifactStep,
): Promise<void> {
  if (step.artifact === 'screenshot') {
    const pathName = generateArtifactPath(
      context,
      step.path,
      'png',
      'screenshot',
    );
    await context.tools.screenshot(pathName);
    return;
  }

  if (step.artifact === 'html') {
    const pathName = generateArtifactPath(context, step.path, 'html', 'page');
    await context.tools.saveHtml(pathName);
  }
}

async function runAiEvaluateStep(
  context: StepContext,
): Promise<void> {
  if (!context.state.lastExtract) {
    throw new Error('ai_evaluate requires extract_news to run first');
  }
  const result = await aiEvaluate({
    extraction: context.state.lastExtract,
  });
  context.state.lastAi = result;
  const decisionLabel = result.ok ? 'APPROVE' : 'REJECT';
  const violationLabel =
    result.violations.length > 0 ? result.violations.join(', ') : 'none';
  logDetail(
    context.depth + 1,
    `[AI:${result.source}] ${decisionLabel} | violations: ${violationLabel}`,
  );
}

async function runDecisionApplyStep(
  context: StepContext,
  step: DecisionApplyStep,
): Promise<void> {
  const decision = interpretBoolean(step.decision_source);
  if (decision === undefined) {
    throw new Error(
      `decision_apply expected boolean decision_source but received "${step.decision_source}"`,
    );
  }

  const selector = decision ? step.ok_selector : step.reject_selector;
  const choice = context.tools.locator(selector).first();
  if ((await choice.count()) === 0) {
    throw new Error(`decision_apply could not find selector "${selector}"`);
  }

  await choice.scrollIntoViewIfNeeded();
  await choice.waitFor({ state: 'visible' });

  const associatedInput =
    (await isInputLocator(choice)) ? choice : await findAssociatedInput(choice, context.tools);

  if (associatedInput) {
    await associatedInput.waitFor({ state: 'attached' });
    await trySelectOption(associatedInput);
    const checked = await associatedInput.isChecked().catch(() => false);
    if (!checked) {
      throw new Error(`Failed to activate decision control for "${selector}"`);
    }
  } else {
    await choice.click();
  }

  if (!decision && step.reason_selector) {
    const reasonRaw =
      step.reason_source && step.reason_source.trim().length > 0
        ? step.reason_source
        : context.state.lastAi?.rejection_message ?? '';
    const reasonText = reasonRaw.trim();
    if (reasonText.length > 0) {
      logDetail(context.depth + 1, `AI rejection reason: ${reasonText}`);
      await context.tools.type(step.reason_selector, '', 'clear');
      await context.tools.type(step.reason_selector, reasonText, 'clear');
    }
  }

  await context.tools.click(step.submit_selector);

  if (step.confirm_selector) {
    await context.tools.waitFor({
      selector: step.confirm_selector,
      timeoutMs: 30_000,
    });
    await context.tools.click(step.confirm_selector);
  }

  const postWaitState = step.post_wait_state ?? 'networkidle';
  if (postWaitState !== 'skip') {
    const postWaitTimeout = step.post_wait_timeout_ms ?? 120_000;
    try {
      await context.tools.waitFor({
        state: postWaitState,
        timeoutMs: postWaitTimeout,
      });
    } catch (error) {
      console.warn(
        `${indent(context.depth + 1)}decision_apply post-wait (${postWaitState}) skipped: ${String(
          (error as { message?: string }).message ?? error,
        )}`,
      );
    }
  }
}

async function runBreakIfStep(
  context: StepContext,
  step: BreakIfStep,
): Promise<void> {
  if (step.condition !== 'selector_empty') {
    return;
  }
  const count = await context.tools.count(step.selector);
  if (count === 0) {
    context.state.shouldHalt = true;
    logDetail(context.depth + 1, `break_if satisfied -> ${step.selector}`);
  } else {
    logDetail(
      context.depth + 1,
      `break_if skipped (${count} elements still present)`,
    );
  }
}

async function runExtractNewsStep(
  context: StepContext,
  step: ExtractNewsStep,
): Promise<void> {
  const extraction = await extractNews(context.tools.getPage());
  context.state.lastExtract = extraction;
  const filePath = await writeJsonArtifact(context, step.path, extraction);
  logDetail(context.depth + 1, `saved extract -> ${filePath}`);
}

async function runForEachStep(
  step: ForEachStep,
  context: StepContext,
): Promise<void> {
  const scopeLocator = context.row
    ? context.row.locator(step.selector)
    : context.tools.locator(step.selector);
  const total = await scopeLocator.count();

  if (total === 0) {
    logDetail(context.depth + 1, `no matches for ${step.selector}`);
    return;
  }

  const previousItemDir = context.state.currentItemDir;

  for (let index = 0; index < total; index += 1) {
    const rowLocator = scopeLocator.nth(index);
    const itemDir = await ensureItemDirectory(context, index);
    context.state.currentItemDir = itemDir;
    logDetail(
      context.depth + 1,
      `row ${index + 1}/${total} -> ${step.selector}`,
    );
    for (const nestedStep of step.steps) {
      const description = describeStep(nestedStep);
      logDetail(context.depth + 2, description);
      await executeStep(nestedStep, {
        ...context,
        row: rowLocator,
        depth: context.depth + 2,
      });
      if (context.state.shouldHalt) {
        context.state.currentItemDir = previousItemDir;
        return;
      }
    }
  }

  context.state.currentItemDir = previousItemDir;
}

async function runWhileSelectorStep(
  step: WhileSelectorStep,
  context: StepContext,
): Promise<void> {
  const maxIterations = step.max_iterations ?? 50;
  const previousItemDir = context.state.currentItemDir;
  let iteration = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remaining = await context.tools.count(step.selector);
    if (remaining === 0) {
      context.state.currentItemDir = previousItemDir;
      return;
    }

    if (iteration >= maxIterations) {
      throw new Error(
        `while_selector exceeded max_iterations (${maxIterations}) for selector "${step.selector}"`,
      );
    }

    const itemDir = await ensureItemDirectory(context, iteration);
    context.state.currentItemDir = itemDir;
    logDetail(
      context.depth + 1,
      `loop ${iteration + 1} -> ${step.selector}`,
    );

    for (const nestedStep of step.steps) {
      const description = describeStep(nestedStep);
      logDetail(context.depth + 2, description);
      await executeStep(nestedStep, {
        ...context,
        row: undefined,
        depth: context.depth + 2,
      });
      if (context.state.shouldHalt) {
        context.state.currentItemDir = previousItemDir;
        return;
      }
    }

    iteration += 1;
  }
}

async function runInRowClickStep(
  context: StepContext,
  step: InRowClickStep,
): Promise<void> {
  if (!context.row) {
    throw new Error('in_row_click requires a row context (use inside foreach)');
  }

  const target = context.row.locator(step.selector).first();
  await target.scrollIntoViewIfNeeded();
  await target.waitFor({ state: 'visible' });
  await target.click();
}

async function isInputLocator(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((node) => node instanceof HTMLInputElement);
  } catch {
    return false;
  }
}

async function findAssociatedInput(
  locator: Locator,
  tools: BrowserTools,
): Promise<Locator | undefined> {
  const descendant = locator
    .locator('input[type="radio"], input[type="checkbox"]')
    .first();
  if ((await descendant.count()) > 0) {
    return descendant;
  }

  try {
    const forAttr = await locator.evaluate(
      (node) => node.getAttribute && node.getAttribute('for'),
    );
    if (forAttr && typeof forAttr === 'string' && forAttr.trim().length > 0) {
      const selector = `[id="${escapeAttributeSelector(forAttr)}"]`;
      const fromId = tools.locator(selector).first();
      if ((await fromId.count()) > 0) {
        return fromId;
      }
    }
  } catch {
    // ignore attribute lookup issues
  }

  return undefined;
}

async function trySelectOption(locator: Locator): Promise<void> {
  try {
    await locator.setChecked(true, { timeout: 5_000 });
    return;
  } catch (setCheckedError) {
    try {
      await locator.check({ force: true, timeout: 2_000 });
      return;
    } catch (checkError) {
      try {
        await locator.click({ force: true, timeout: 2_000 });
        return;
      } catch {
        await locator.evaluate((node) => {
          if (node instanceof HTMLInputElement) {
            if (node.type === 'radio') {
              const group = node.form
                ? Array.from(node.form.elements).filter(
                    (el): el is HTMLInputElement =>
                      el instanceof HTMLInputElement &&
                      el.type === 'radio' &&
                      el.name === node.name,
                  )
                : [];
              group.forEach((radio) => {
                if (radio !== node) {
                  radio.checked = false;
                }
              });
            }
            if (!node.checked) {
              node.checked = true;
            }
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (node instanceof HTMLElement) {
            node.click();
          }
        });
      }
    }
  }
}

function escapeAttributeSelector(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}

function indent(level: number): string {
  if (level <= 0) {
    return '';
  }
  return '  '.repeat(level);
}

function logDetail(depth: number, message: string): void {
  console.log(`${indent(depth)}- ${message}`);
}

function logStepBanner(current: number, total: number, label: string): void {
  const heading = `Step ${current}/${total}`;
  const lines = [heading, label];
  const width = Math.max(...lines.map((line) => line.length)) + 6;
  const border = '='.repeat(width);
  const format = (text: string): string => `| ${text.padEnd(width - 4)} |`;
  console.log(`\n${border}`);
  console.log(format(heading));
  console.log(format(label));
  console.log(border);
}

function interpretBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'approve', 'ok'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'reject'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function shouldRetryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = (error as { message?: string }).message?.toLowerCase() ?? '';
  if (!message) {
    return false;
  }
  return (
    message.includes('timeout') ||
    message.includes('net::') ||
    message.includes('navigation') ||
    message.includes('temporarily') ||
    message.includes('network')
  );
}

async function writeJsonArtifact(
  context: StepContext,
  requestedPath: string | undefined,
  data: unknown,
): Promise<string> {
  const targetPath = generateArtifactPath(
    context,
    requestedPath,
    'json',
    'extract',
  );

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(data, null, 2), 'utf-8');
  return targetPath;
}

async function ensureItemDirectory(
  context: StepContext,
  index: number,
): Promise<string> {
  const dirName = `item-${String(index + 1).padStart(3, '0')}`;
  const dirPath = path.join(context.state.runArtifactsDir, dirName);
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function generateArtifactPath(
  context: StepContext,
  requestedPath: string | undefined,
  extension: string,
  prefix: string,
): string {
  if (requestedPath) {
    return path.isAbsolute(requestedPath)
      ? requestedPath
      : path.join(context.state.runArtifactsDir, requestedPath);
  }
  const baseDir = context.state.currentItemDir ?? context.state.runArtifactsDir;
  const fileName = `${prefix}-${Date.now().toString(36)}.${extension}`;
  return path.join(baseDir, fileName);
}


