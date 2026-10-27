import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFlags } from "./flags.ts";
import type { ResolvedOptions } from "./options.ts";
import { recordEvent } from "./learning-log.ts";
import { SKILL_FILES } from "./skills-bundle.ts";
import { projectHints, routeSkill, skillName } from "./skill-router.ts";
import { showCard } from "./text.ts";

export function installSkillRouter(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  const files = opts.skillFiles ?? SKILL_FILES;
  const skills = Object.entries(files).map(([id, content]) => ({
    id,
    description: /^description: "(.+)"$/m.exec(content["SKILL.md"] ?? "")?.[1] ?? id,
  }));
  pi.on("before_agent_start", async (event, ctx) => {
    if (
      event.messageType !== "user" ||
      !readFlags(opts.settingsPath).skills ||
      !readFlags(opts.settingsPath).skillRouter
    )
      return;
    const result = await routeSkill(
      event.prompt,
      skills,
      projectHints(ctx.cwd),
      ctx,
      opts.skillRouter,
    );
    const selected = result.confidence >= 0.7 ? result.skill : "none";
    recordEvent(ctx, { kind: "skill.routed", sig: `skill:${selected}` });
    const body = selected === "none" ? undefined : files[selected]?.["SKILL.md"];
    // Выбор сделал маршрутизатор: остальные навыки модель не видит — путать не из чего (#42). Выбранный остаётся в
    // списке ради пути к его файлам; его текст — сразу разделом, без лишнего чтения.
    const listed = event.systemPromptOptions.skills;
    if (listed)
      event.systemPromptOptions.skills = body ? listed.filter((s) => s.name === selected) : [];
    if (!body) return;
    event.systemPromptOptions.sections.prsloy_skill = body;
    await showCard(pi, "prsloy-harness.skill", `Взял навык: ${skillName(selected)}`);
  });
}
