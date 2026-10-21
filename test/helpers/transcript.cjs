// Test-only decoding: production recovery matches the saved payload verbatim.
exports.entries = (batch) =>
  batch.payload
    .split('\n\n')
    .slice(1)
    .map((block) => {
      const [speaker, metadata, ...quoted] = block.split('\n');
      if (
        !speaker.startsWith('**') ||
        !metadata.startsWith('(message: ') ||
        quoted.some((line) => !line.startsWith('> '))
      )
        throw Error('Invalid transcript message structure');
      return {
        id: metadata.match(/^\(message: (\d+)/)[1],
        offset: Number(metadata.match(/offset: (\d+)/)?.[1] ?? 0),
        text: quoted.map((line) => line.slice(2)).join('\n'),
      };
    });
