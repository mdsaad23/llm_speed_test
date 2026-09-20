import { describe, expect, it } from 'vitest';
import { GET } from './route';

const get = (qs: string) => GET(new Request(`http://localhost/api/prompt?${qs}`));

describe('prompt preview endpoint', () => {
  it('renders the configured board into the user message', async () => {
    const body = await (await get('mode=deadline&hints=false&w=8&h=8&baseDeadlineMs=500')).json();
    expect(body.system).toMatch(/absolute compass directions/);
    expect(JSON.parse(body.example)).toMatchObject({ grid: { w: 8, h: 8 }, tick: 0, deadline_ms: 500 });
    expect(body.version).toHaveLength(12);
  });

  it('never offers the 180 degree reversal of the current heading', async () => {
    const body = await (await get('mode=deadline&hints=false')).json();
    expect(JSON.parse(body.example).illegal_move).toBe('LEFT');
    expect(JSON.parse(body.schema).properties.move.enum).toEqual(['UP', 'DOWN', 'RIGHT']);
  });

  it('adds hint fields only when asked', async () => {
    const plain = await (await get('mode=deadline&hints=false')).json();
    const hinted = await (await get('mode=deadline&hints=true')).json();
    expect(JSON.parse(plain.example).safe).toBeUndefined();
    expect(JSON.parse(hinted.example).safe).toBeDefined();
    expect(hinted.version).not.toBe(plain.version);
  });

  it('falls back to official settings when the query is junk', async () => {
    const body = await (await get('mode=nonsense&w=99999&paceFactor=-4')).json();
    expect(JSON.parse(body.example)).toMatchObject({ grid: { w: 20, h: 20 }, deadline_ms: 8000 });
  });
});
