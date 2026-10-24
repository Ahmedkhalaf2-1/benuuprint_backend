/**
 * Validation and defaulting of a workflow definition (stage entries + dependency
 * edges). Stages are addressed by `sequence`; a dependency is "all of these must be
 * done first". Omitting `dependsOnSequences` means "depends on the previous stage"
 * (sequential default); an explicit empty list means "no dependency" (a root), which
 * is how parallel branches are expressed.
 */
export interface WorkflowStageInput {
  sequence: number;
  stageCode: string;
  isQcStage: boolean;
  dependsOnSequences?: number[];
}

export interface ResolvedStage extends WorkflowStageInput {
  dependsOnSequences: number[];
}

export function resolveDependencies(
  stages: WorkflowStageInput[],
): ResolvedStage[] {
  const ordered = [...stages].sort((a, b) => a.sequence - b.sequence);
  return ordered.map((stage, index) => ({
    ...stage,
    dependsOnSequences:
      stage.dependsOnSequences ??
      (index === 0 ? [] : [ordered[index - 1]!.sequence]),
  }));
}

export function validateWorkflow(stages: WorkflowStageInput[]): string[] {
  const problems: string[] = [];
  if (stages.length === 0) return ['a workflow needs at least one stage'];

  const seen = new Set<number>();
  for (const s of stages) {
    if (seen.has(s.sequence))
      problems.push(`sequence ${s.sequence} is used more than once`);
    seen.add(s.sequence);
  }
  if (problems.length) return problems;

  const resolved = resolveDependencies(stages);
  const bySeq = new Map(resolved.map((s) => [s.sequence, s]));
  for (const s of resolved) {
    for (const dep of s.dependsOnSequences) {
      if (dep === s.sequence)
        problems.push(`stage ${s.sequence} cannot depend on itself`);
      else if (!bySeq.has(dep))
        problems.push(`stage ${s.sequence} depends on unknown sequence ${dep}`);
    }
    if (new Set(s.dependsOnSequences).size !== s.dependsOnSequences.length) {
      problems.push(`stage ${s.sequence} lists the same dependency twice`);
    }
    // A QC gate must follow the work it inspects; rework targets that work by default.
    if (s.isQcStage && s.dependsOnSequences.length === 0) {
      problems.push(
        `QC stage ${s.sequence} (${s.stageCode}) must depend on the stage it inspects`,
      );
    }
  }
  if (problems.length) return problems;

  // Cycle detection (Kahn).
  const indegree = new Map(
    resolved.map((s) => [s.sequence, s.dependsOnSequences.length]),
  );
  const queue = resolved
    .filter((s) => s.dependsOnSequences.length === 0)
    .map((s) => s.sequence);
  let visited = 0;
  while (queue.length) {
    const next = queue.shift()!;
    visited += 1;
    for (const s of resolved) {
      if (s.dependsOnSequences.includes(next)) {
        const left = indegree.get(s.sequence)! - 1;
        indegree.set(s.sequence, left);
        if (left === 0) queue.push(s.sequence);
      }
    }
  }
  if (visited !== resolved.length)
    problems.push('the dependencies contain a cycle');
  return problems;
}
