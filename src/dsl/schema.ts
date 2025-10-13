import { LoadState } from '../lib/browserTools';

type TypeMode = 'clear' | 'append';

export type Step =
  | NavigateStep
  | TypeStep
  | ClickStep
  | WaitForStep
  | AssertStep
  | ArtifactStep
  | ExtractNewsStep
  | AiEvaluateStep
  | DecisionApplyStep
  | BreakIfStep
  | ForEachStep
  | InRowClickStep
  | WhileSelectorStep;

export interface NavigateStep {
  type: 'navigate';
  url: string;
  wait_until?: LoadState;
  timeout_ms?: number;
}

export interface TypeStep {
  type: 'type';
  selector: string;
  value: string;
  mode?: TypeMode;
}

export interface ClickStep {
  type: 'click';
  selector: string;
}

export interface WaitForStep {
  type: 'wait_for';
  selector?: string;
  state?: LoadState;
  timeout_ms?: number;
}

export type AssertStep = ContainsTextAssertStep | EmptySelectorAssertStep;

export interface ContainsTextAssertStep {
  type: 'assert';
  assert: 'contains_text';
  selector: string;
  value: string;
}

export interface EmptySelectorAssertStep {
  type: 'assert';
  assert: 'empty_selector';
  selector: string;
}

export interface ArtifactStep {
  type: 'artifact';
  artifact: 'screenshot' | 'html';
  path?: string;
}

export interface ExtractNewsStep {
  type: 'extract_news';
  path?: string;
}

export interface AiEvaluateStep {
  type: 'ai_evaluate';
}

export interface DecisionApplyStep {
  type: 'decision_apply';
  ok_selector: string;
  reject_selector: string;
  reason_selector?: string;
  submit_selector: string;
  confirm_selector?: string;
  decision_source: string;
  reason_source?: string;
  post_wait_state?: LoadState | 'skip';
  post_wait_timeout_ms?: number;
}

export interface BreakIfStep {
  type: 'break_if';
  condition: 'selector_empty';
  selector: string;
}

export interface ForEachStep {
  type: 'foreach';
  selector: string;
  steps: Step[];
}

export interface InRowClickStep {
  type: 'in_row_click';
  selector: string;
}

export interface WhileSelectorStep {
  type: 'while_selector';
  selector: string;
  steps: Step[];
  max_iterations?: number;
}

export interface TaskDefinition {
  name?: string;
  steps: Step[];
}

export function validateTaskDefinition(
  raw: unknown,
  source = 'task',
): TaskDefinition {
  if (!isRecord(raw)) {
    throw new Error(`${source}: root must be an object`);
  }

  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error(`${source}: "steps" must be a non-empty array`);
  }

  const steps = stepsRaw.map((step, index) =>
    validateStep(step, `${source}.steps[${index}]`),
  );

  return { name, steps };
}

function validateStep(step: unknown, path: string): Step {
  if (!isRecord(step)) {
    throw new Error(`${path}: step must be an object`);
  }

  const type = step.type;
  if (typeof type !== 'string') {
    throw new Error(`${path}: missing "type"`);
  }

  switch (type) {
    case 'navigate':
      return validateNavigateStep(step, path);
    case 'type':
      return validateTypeStep(step, path);
    case 'click':
      return validateClickStep(step, path);
    case 'wait_for':
      return validateWaitForStep(step, path);
    case 'assert':
      return validateAssertStep(step, path);
    case 'artifact':
      return validateArtifactStep(step, path);
    case 'extract_news':
      return validateExtractNewsStep(step, path);
    case 'ai_evaluate':
      return validateAiEvaluateStep(step, path);
    case 'decision_apply':
      return validateDecisionApplyStep(step, path);
    case 'break_if':
      return validateBreakIfStep(step, path);
    case 'foreach':
      return validateForEachStep(step, path);
    case 'in_row_click':
      return validateInRowClickStep(step, path);
    case 'while_selector':
      return validateWhileSelectorStep(step, path);
    default:
      throw new Error(`${path}: unsupported step type "${type}"`);
  }
}

function validateNavigateStep(
  step: Record<string, unknown>,
  path: string,
): NavigateStep {
  const url = step.url;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(`${path}: "url" must be a non-empty string`);
  }
  const waitUntil = step.wait_until;
  if (waitUntil !== undefined && !isLoadState(waitUntil)) {
    throw new Error(
      `${path}: "wait_until" must be load|domcontentloaded|networkidle`,
    );
  }
  return {
    type: 'navigate',
    url,
    wait_until: waitUntil as LoadState | undefined,
  };
}

function validateTypeStep(
  step: Record<string, unknown>,
  path: string,
): TypeStep {
  const selector = step.selector;
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error(`${path}: "selector" must be a non-empty string`);
  }

  const value = step.value;
  if (typeof value !== 'string') {
    throw new Error(`${path}: "value" must be a string`);
  }

  const mode = step.mode;
  if (mode !== undefined && mode !== 'clear' && mode !== 'append') {
    throw new Error(`${path}: "mode" must be clear|append`);
  }

  return {
    type: 'type',
    selector,
    value,
    mode: mode as TypeMode | undefined,
  };
}

function validateClickStep(
  step: Record<string, unknown>,
  path: string,
): ClickStep {
  const selector = step.selector;
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error(`${path}: "selector" must be a non-empty string`);
  }

  return {
    type: 'click',
    selector,
  };
}

function validateWaitForStep(
  step: Record<string, unknown>,
  path: string,
): WaitForStep {
  const selector = step.selector;
  const state = step.state;
  const timeout = step.timeout_ms;

  if (selector === undefined && state === undefined && timeout === undefined) {
    throw new Error(`${path}: wait_for requires "selector", "state", or "timeout_ms"`);
  }

  if (selector !== undefined && typeof selector !== 'string') {
    throw new Error(`${path}: "selector" must be a string when provided`);
  }

  if (state !== undefined && !isLoadState(state)) {
    throw new Error(`${path}: "state" must be load|domcontentloaded|networkidle`);
  }

  if (timeout !== undefined && !isPositiveInteger(timeout)) {
    throw new Error(`${path}: "timeout_ms" must be a positive integer`);
  }

  return {
    type: 'wait_for',
    selector: selector as string | undefined,
    state: state as LoadState | undefined,
    timeout_ms: timeout as number | undefined,
  };
}

function validateAssertStep(
  step: Record<string, unknown>,
  path: string,
): AssertStep {
  const assert = step.assert;
  if (assert === 'contains_text') {
    const selector = requireString(step.selector, `${path}.selector`);
    const value = requireString(step.value, `${path}.value`);
    return {
      type: 'assert',
      assert,
      selector,
      value,
    };
  }
  if (assert === 'empty_selector') {
    const selector = requireString(step.selector, `${path}.selector`);
    return {
      type: 'assert',
      assert,
      selector,
    };
  }
  throw new Error(
    `${path}: "assert" must be contains_text or empty_selector`,
  );
}

function validateArtifactStep(
  step: Record<string, unknown>,
  path: string,
): ArtifactStep {
  const artifact = step.artifact;
  if (artifact !== 'screenshot' && artifact !== 'html') {
    throw new Error(`${path}: "artifact" must be screenshot|html`);
  }

  const filePath = step.path;
  if (filePath !== undefined && !isString(filePath)) {
    throw new Error(`${path}: "path" must be a string when provided`);
  }

  return {
    type: 'artifact',
    artifact,
    path: filePath as string | undefined,
  };
}

function validateExtractNewsStep(
  step: Record<string, unknown>,
  path: string,
): ExtractNewsStep {
  const filePath = step.path;
  if (filePath !== undefined && !isString(filePath)) {
    throw new Error(`${path}: "path" must be a string when provided`);
  }

  return {
    type: 'extract_news',
    path: filePath as string | undefined,
  };
}

function validateAiEvaluateStep(
  step: Record<string, unknown>,
  path: string,
): AiEvaluateStep {
  if (Object.keys(step).length > 1) {
    throw new Error(`${path}: ai_evaluate does not accept additional fields`);
  }
  return { type: 'ai_evaluate' };
}

function validateDecisionApplyStep(
  step: Record<string, unknown>,
  path: string,
): DecisionApplyStep {
  const ok = requireString(step.ok_selector, `${path}.ok_selector`);
  const reject = requireString(step.reject_selector, `${path}.reject_selector`);
  const submit = requireString(step.submit_selector, `${path}.submit_selector`);
  const confirmSelector = step.confirm_selector;
  if (
    confirmSelector !== undefined &&
    (typeof confirmSelector !== 'string' || confirmSelector.trim() === '')
  ) {
    throw new Error(`${path}: "confirm_selector" must be a non-empty string when provided`);
  }
  const decisionSource = requireString(
    step.decision_source,
    `${path}.decision_source`,
  );

  const reasonSelector = step.reason_selector;
  if (
    reasonSelector !== undefined &&
    (typeof reasonSelector !== 'string' || reasonSelector.trim() === '')
  ) {
    throw new Error(`${path}: "reason_selector" must be a non-empty string when provided`);
  }

  const reasonSource = step.reason_source;
  if (reasonSource !== undefined && typeof reasonSource !== 'string') {
    throw new Error(`${path}: "reason_source" must be a string when provided`);
  }

  const rawPostWaitState = step.post_wait_state;
  let postWaitState: LoadState | 'skip' | undefined;
  if (rawPostWaitState !== undefined) {
    if (rawPostWaitState === 'skip') {
      postWaitState = 'skip';
    } else if (isLoadState(rawPostWaitState)) {
      postWaitState = rawPostWaitState;
    } else {
      throw new Error(
        `${path}: "post_wait_state" must be one of "load", "domcontentloaded", "networkidle", or "skip"`,
      );
    }
  }

  const rawPostWaitTimeout = step.post_wait_timeout_ms;
  let postWaitTimeout: number | undefined;
  if (rawPostWaitTimeout !== undefined) {
    if (!isPositiveInteger(rawPostWaitTimeout)) {
      throw new Error(`${path}: "post_wait_timeout_ms" must be a positive integer when provided`);
    }
    postWaitTimeout = rawPostWaitTimeout as number;
  }

  return {
    type: 'decision_apply',
    ok_selector: ok,
    reject_selector: reject,
    reason_selector: reasonSelector as string | undefined,
    submit_selector: submit,
    confirm_selector: confirmSelector as string | undefined,
    decision_source: decisionSource,
    reason_source: reasonSource as string | undefined,
    post_wait_state: postWaitState,
    post_wait_timeout_ms: postWaitTimeout,
  };
}

function validateBreakIfStep(
  step: Record<string, unknown>,
  path: string,
): BreakIfStep {
  const condition = step.condition;
  if (condition !== 'selector_empty') {
    throw new Error(`${path}: break_if.condition must be "selector_empty"`);
  }
  const selector = requireString(step.selector, `${path}.selector`);
  return {
    type: 'break_if',
    condition: 'selector_empty',
    selector,
  };
}

function validateForEachStep(
  step: Record<string, unknown>,
  path: string,
): ForEachStep {
  const selector = requireString(step.selector, `${path}.selector`);
  const steps = step.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${path}: "steps" must be a non-empty array`);
  }

  const nestedSteps = steps.map((child, index) =>
    validateStep(child, `${path}.steps[${index}]`),
  );

  return {
    type: 'foreach',
    selector,
    steps: nestedSteps,
  };
}

function validateInRowClickStep(
  step: Record<string, unknown>,
  path: string,
): InRowClickStep {
  const selector = requireString(step.selector, `${path}.selector`);
  return {
    type: 'in_row_click',
    selector,
  };
}

function validateWhileSelectorStep(
  step: Record<string, unknown>,
  path: string,
): WhileSelectorStep {
  const selector = requireString(step.selector, `${path}.selector`);
  const steps = step.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${path}: "steps" must be a non-empty array`);
  }

  const nestedSteps = steps.map((child, index) =>
    validateStep(child, `${path}.steps[${index}]`),
  );

  const rawMaxIterations = step.max_iterations;
  let maxIterations: number | undefined;
  if (rawMaxIterations !== undefined) {
    if (!isPositiveInteger(rawMaxIterations)) {
      throw new Error(`${path}: "max_iterations" must be a positive integer`);
    }
    maxIterations = rawMaxIterations as number;
  }

  return {
    type: 'while_selector',
    selector,
    steps: nestedSteps,
    max_iterations: maxIterations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function isLoadState(value: unknown): value is LoadState {
  return value === 'load' || value === 'domcontentloaded' || value === 'networkidle';
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0
  );
}
