#!/usr/bin/env bun
import { Cli } from 'incur'
import pkg from '../package.json'
import { init } from './commands/init.js'
import { identity } from './commands/identity.js'
import { soul } from './commands/soul.js'
import { persona } from './commands/persona.js'
import { rules } from './commands/rules.js'
import { brain } from './commands/brain.js'
import { status } from './commands/status.js'
import { reset } from './commands/reset.js'
import { shell } from './commands/shell.js'
import { compose } from './commands/compose.js'
import { sync } from './commands/sync.js'
import { hooks } from './commands/hooks.js'
import { pack } from './commands/pack.js'

Cli.create('brainjar', {
  description: 'Shape how your AI thinks — identity, soul, persona, rules',
  version: pkg.version,
  sync: { depth: 0 },
})
  .command(init)
  .command(status)
  .command(soul)
  .command(persona)
  .command(rules)
  .command(brain)
  .command(identity)
  .command(reset)
  .command(shell)
  .command(compose)
  .command(sync)
  .command(hooks)
  .command(pack)
  .serve()
