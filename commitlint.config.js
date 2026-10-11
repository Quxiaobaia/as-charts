/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'core',
        'shader',
        'renderer',
        'layers',
        'geometry',
        'data',
        'text',
        'pick',
        'build',
        'test',
        'docs',
        'deps',
        'ci',
        'release',
      ],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
