import type { NextConfig } from 'next';
export default {
  // Replays are read with fs at request time, which the build's file tracing cannot see.
  outputFileTracingIncludes: { '/api/replays': ['./results/replays/**/*'] },
} satisfies NextConfig;
