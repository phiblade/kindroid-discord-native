// Test fixtures enable message IDs. Production never parses these transcripts.
exports.entries = (batch) => {
  const body = batch.payload.slice(
    batch.payload.indexOf('\n\n') + 2,
    batch.payload.lastIndexOf('\n\n'),
  );
  const headers = [
    ...body.matchAll(
      /^(\d+) (?:\d{4}-\d{2}-\d{2} )?(?:\d{2}:\d{2} UTC )?\*\*[^\n]*?\*\*(?: \[~[^\n]*?\])?(?: \[(\d+)\|(?:more|end)\])?\n/gm,
    ),
  ];
  return headers.map((match, i) => ({
    id: match[1],
    offset: Number(match[2] ?? 0),
    text: body.slice(
      match.index + match[0].length,
      i + 1 < headers.length ? headers[i + 1].index - 2 : undefined,
    ),
  }));
};
