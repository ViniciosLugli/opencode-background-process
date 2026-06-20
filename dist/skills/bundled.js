/*
This module registers bundled skills that ship with the plugin package.
It resolves skill paths relative to the compiled entry point without writing files.
*/
import { access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "node:url";
const resolveBundledSkillPaths = async () => {
    const baseDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [baseDir, path.join(baseDir, "..", "..", "skills")];
    for (const candidate of candidates) {
        try {
            await access(path.join(candidate, "background-process", "SKILL.md"));
            return [candidate];
        }
        catch {
            // Ignore missing paths
        }
    }
    return [];
};
const registerSkillPaths = (config, paths) => {
    if (paths.length === 0)
        return;
    config.skills ??= {};
    config.skills.paths ??= [];
    config.skill ??= {};
    config.skill.paths ??= [];
    for (const skillPath of paths) {
        if (!config.skills.paths.includes(skillPath))
            config.skills.paths.push(skillPath);
        if (!config.skill.paths.includes(skillPath))
            config.skill.paths.push(skillPath);
    }
};
export const createBundledSkillsHook = () => {
    return {
        config: async (config) => {
            const paths = await resolveBundledSkillPaths();
            registerSkillPaths(config, paths);
        },
    };
};
//# sourceMappingURL=bundled.js.map