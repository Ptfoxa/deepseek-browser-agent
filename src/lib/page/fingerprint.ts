const KEY_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,input,textarea,select,button,form,a';

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function fingerprintParts(url: string, title: string, signature: string): string {
  return fnv1a64(`${url}\u0000${title}\u0000${signature}`);
}

export function fingerprintDocument(doc: Document, url: string): string {
  const keyNodes = [...doc.querySelectorAll(KEY_SELECTOR)].slice(0, 300);
  const signature = keyNodes
    .map((element) => `${element.tagName.toLowerCase()}:${(element as HTMLInputElement).type ?? ''}`)
    .join(',');
  const bodyChildren = doc.body?.children.length ?? 0;
  return fingerprintParts(url, doc.title, `${bodyChildren}|${signature}`);
}
