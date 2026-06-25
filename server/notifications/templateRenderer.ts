import { allowedVariableNames } from "./templateCatalog.ts";

export type TemplateValidationResult = {
  ok: boolean;
  variables: string[];
  errors: string[];
};

export type TemplateRenderResult =
  | { ok: true; rendered: string; variables: string[] }
  | { ok: false; errors: string[]; missingVariables: string[]; variables: string[] };

export function validateTemplate(
  source: string,
  eventType: string,
  template: string | null,
): TemplateValidationResult {
  if (template === null || template.trim().length === 0) {
    return { ok: true, variables: [], errors: [] };
  }

  const parsed = parseTemplate(template);
  const allowed = allowedVariableNames(source, eventType);
  const errors = [...parsed.errors];

  for (const variable of parsed.variables) {
    if (!allowed.has(variable)) {
      errors.push(`Unknown variable {${variable}} for ${source}:${eventType}`);
    }
  }

  return {
    ok: errors.length === 0,
    variables: [...new Set(parsed.variables)],
    errors,
  };
}

export function renderTemplate(
  source: string,
  eventType: string,
  template: string | null,
  context: Record<string, string | null | undefined>,
): TemplateRenderResult {
  const value = template ?? "";
  const validation = validateTemplate(source, eventType, value);

  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      missingVariables: [],
      variables: validation.variables,
    };
  }

  const missingVariables = validation.variables.filter((variable) => {
    const contextValue = context[variable];
    return contextValue === null || contextValue === undefined ||
      String(contextValue).trim().length === 0;
  });

  if (missingVariables.length > 0) {
    return {
      ok: false,
      errors: missingVariables.map((variable) => `Missing value for {${variable}}`),
      missingVariables,
      variables: validation.variables,
    };
  }

  let rendered = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === "{" && next === "{") {
      rendered += "{";
      index += 1;
      continue;
    }

    if (char === "}" && next === "}") {
      rendered += "}";
      index += 1;
      continue;
    }

    if (char === "{") {
      const end = value.indexOf("}", index + 1);
      const variable = value.slice(index + 1, end);
      rendered += String(context[variable] ?? "");
      index = end;
      continue;
    }

    rendered += char;
  }

  return { ok: true, rendered, variables: validation.variables };
}

function parseTemplate(template: string): { variables: string[]; errors: string[] } {
  const variables: string[] = [];
  const errors: string[] = [];

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    const next = template[index + 1];

    if ((char === "{" && next === "{") || (char === "}" && next === "}")) {
      index += 1;
      continue;
    }

    if (char === "}") {
      errors.push("Unexpected closing brace. Use }} for a literal }.");
      continue;
    }

    if (char !== "{") {
      continue;
    }

    const end = template.indexOf("}", index + 1);
    if (end === -1) {
      errors.push("Unclosed variable token. Use {{ for a literal {.");
      break;
    }

    const name = template.slice(index + 1, end);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`Invalid variable token {${name}}`);
    } else {
      variables.push(name);
    }

    index = end;
  }

  return { variables, errors };
}
