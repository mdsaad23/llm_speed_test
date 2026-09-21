import { describe, expect, it } from 'vitest';
import { moveEntropy, referenceAgreement, stateBlind } from '@/lib/metrics/metrics';

const pair = (move: string, reference: string) => ({ move, reference });
/** A reference that varies, so there is always something for the move to track or miss. */
const varyingReference = (n: number) => Array.from({ length: n }, (_, i) => ['UP', 'LEFT', 'DOWN'][i % 3]);

describe('moveEntropy', () => {
  it('is 0 for one move repeated', () => {
    expect(moveEntropy(Array(20).fill('RIGHT'))).toBe(0);
  });

  it('is 1 for an even spread over all four moves', () => {
    expect(moveEntropy(['UP', 'LEFT', 'DOWN', 'RIGHT'])).toBeCloseTo(1, 10);
  });

  it('stays under 1 for a game that only ever needed three', () => {
    expect(moveEntropy(['UP', 'LEFT', 'DOWN'])).toBeLessThan(1);
  });

  it('is null with nothing to measure', () => {
    expect(moveEntropy([])).toBeNull();
  });
});

describe('referenceAgreement', () => {
  it('is 1 when every move matches the reference', () => {
    const pairs = varyingReference(12).map((r) => pair(r, r));
    expect(referenceAgreement(pairs).observed).toBe(1);
    expect(referenceAgreement(pairs).kappa).toBe(1);
  });

  it('gives a fixed answer no credit for the boards it happens to get right', () => {
    // Answers RIGHT forever; the reference says RIGHT on a third of the boards by coincidence.
    const pairs = varyingReference(30).map((r, i) => pair('RIGHT', i % 3 === 0 ? 'RIGHT' : r));
    const { observed, kappa } = referenceAgreement(pairs);
    expect(observed).toBeGreaterThan(0.3);
    expect(kappa).toBeCloseTo(0, 10);
  });

  it('goes negative when the moves avoid the reference', () => {
    const pairs = varyingReference(30).map((r) => pair(r === 'UP' ? 'DOWN' : 'UP', r));
    expect(referenceAgreement(pairs).kappa!).toBeLessThan(0);
  });

  it('has no kappa when chance already explains everything', () => {
    expect(referenceAgreement(Array(12).fill(pair('UP', 'UP'))).kappa).toBeNull();
  });

  it('is null with nothing to measure', () => {
    expect(referenceAgreement([])).toEqual({ observed: null, kappa: null });
  });
});

describe('stateBlind', () => {
  const fixedAnswer = (n: number) => varyingReference(n).map((r) => pair("RIGHT", r));

  it('flags a fixed answer once there is enough of it', () => {
    const pairs = fixedAnswer(30);
    expect(stateBlind(pairs, referenceAgreement(pairs).kappa)).toBe(true);
  });

  it('spares a model that tracks the board', () => {
    const pairs = varyingReference(30).map((r) => pair(r, r));
    expect(stateBlind(pairs, referenceAgreement(pairs).kappa)).toBe(false);
  });

  it('holds off until there are enough decisions to mean anything', () => {
    const pairs = fixedAnswer(5);
    expect(stateBlind(pairs, referenceAgreement(pairs).kappa)).toBe(false);
  });

  it('flags a stuck answer even when the right answer never moved', () => {
    // A snake that dies without eating leaves the food where it was: the reference points one way
    // the whole game, and a fixed answer is still a fixed answer.
    const pairs = Array(10).fill(pair('RIGHT', 'UP'));
    expect(stateBlind(pairs, referenceAgreement(pairs).kappa)).toBe(true);
  });

  it('spares a model that answered the one move the board kept asking for', () => {
    const pairs = Array(10).fill(pair('UP', 'UP'));
    expect(stateBlind(pairs, referenceAgreement(pairs).kappa)).toBe(false);
  });

  it('spares a model that varies against a fixed right answer — bad, not blind', () => {
    const pairs = ['UP', 'LEFT', 'DOWN', 'UP', 'LEFT', 'DOWN', 'UP', 'LEFT', 'DOWN', 'UP']
      .map((m) => pair(m, 'UP'));
    expect(stateBlind(pairs, referenceAgreement(pairs).kappa)).toBe(false);
  });

});
