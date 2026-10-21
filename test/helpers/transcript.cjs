// Test fixtures enable message IDs. Production never parses these transcripts.
exports.entries = (batch) => {
  const speakersStart = batch.payload.indexOf('\n\n') + 2;
  const body = batch.payload.slice(
    batch.payload.indexOf('\n\n', speakersStart) + 2,
  );
  const headers = [
    ...body.matchAll(
      /^(\d+) (?:\d{2}\/\d{2} )?(?:\d{2}:\d{2} )?\*\*[^\n]*?\*\*(?: \[~[^\n]*?\])?(?: \[(\d+)\|(?:more|end)\])?\n/gm,
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
