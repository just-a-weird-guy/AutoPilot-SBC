export async function solveChallenge(input) {
  const squadSize =
    input?.challenge?.squadSize ??
    input?.challenge?.squadSlots?.length ??
    11;

  return {
    playerIds: (input?.players || []).slice(0, squadSize).map((player) => player.id),
    meta: {
      strategy: "replace this stub with a real solver",
    },
  };
}

export default solveChallenge;
