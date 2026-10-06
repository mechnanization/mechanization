/**
 * The argument names an ICU message uses, including those inside plural and
 * select branches. Branch keys (`=1`, `other`, `yes`) are not arguments.
 */
export function argumentNames(message: string): string[] {
  const names = new Set<string>();

  const readBlock = (text: string, start: number): [string, number] => {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return [text.slice(start + 1, i), i + 1];
    }
    throw new Error(`unbalanced braces in: ${text}`);
  };

  const walk = (text: string) => {
    for (let i = 0; i < text.length; ) {
      if (text[i] !== '{') {
        i++;
        continue;
      }
      const [inner, next] = readBlock(text, i);
      i = next;
      const [name, type, ...rest] = inner.split(',');
      names.add(name.trim());
      if (type && ['plural', 'select'].includes(type.trim())) {
        const options = rest.join(',');
        for (let j = 0; j < options.length; ) {
          if (options[j] !== '{') {
            j++;
            continue;
          }
          const [body, after] = readBlock(options, j);
          walk(body);
          j = after;
        }
      }
    }
  };

  walk(message);
  return [...names].sort();
}

/**
 * The rich-text tags a message uses (`<strong>…</strong>` read with `t.rich`).
 * A tag one locale has and the other lacks renders as plain text there, or
 * not at all, without an error.
 */
export function tagNames(message: string): string[] {
  return [...new Set([...message.matchAll(/<([a-zA-Z][\w-]*)>/g)].map((match) => match[1]))].sort();
}
