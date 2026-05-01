export interface SkillDefinition {
  name: string
  description: string
}

export interface SkillRegistry {
  skills: SkillDefinition[]
  byName: Map<string, SkillDefinition>
}

export function buildSkillRegistry(skills: SkillDefinition[]): SkillRegistry {
  return {
    skills,
    byName: new Map(skills.map((skill) => [skill.name, skill]))
  }
}

export function listSkills(registry: SkillRegistry): SkillDefinition[] {
  return registry.skills
}

export function getSkillsByNames(names: string[], registry?: SkillRegistry): SkillDefinition[] {
  if (!registry) {
    return []
  }

  const lookup = new Set(names)
  return registry.skills.filter((skill) => lookup.has(skill.name))
}
