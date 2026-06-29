// Maps Anthropic tool definitions to the action implementations.
const actions = require('./minecraft-actions')

const tools = [
  {
    name: 'observe',
    description: 'Get the bot’s current state: position, health, food, held item, inventory, and nearby entities. Call this before acting when unsure of the situation.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'sleep',
    description: 'Find the nearest bed within range, walk to it, and sleep (skips the night). Only works at night or during a thunderstorm, with no monsters nearby.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'boatTo',
    description: 'Travel across water by boat to (x, z). Uses a nearby boat if there is one, else places a boat from inventory onto nearby water, rides toward the target, and dismounts. Best-effort steering.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'z'],
    },
  },
  {
    name: 'saveWaypoint',
    description: 'Save a named waypoint at the commander\'s current position (e.g. "saveWaypoint home"). Saved to disk, survives restarts.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'tpWaypoint',
    description: 'Teleport the bot to a saved waypoint by name. Requires the bot to be opped (uses /tp).',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'tpMe',
    description: 'Teleport the commander (you) to a saved waypoint by name. Requires the bot to be opped (uses /tp).',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'listWaypoints',
    description: 'List all saved waypoints and their coordinates.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'deleteWaypoint',
    description: 'Delete a saved waypoint by name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'inventory',
    description: 'Report what the bot is carrying — a readable list of item names and counts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'chat',
    description: 'Send a message in the in-game chat. Use this to talk to players.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'goTo',
    description: 'Walk to specific block coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'tpXYZ',
    description: 'Instantly teleport to specific block coordinates (needs the bot to be opped). Use goTo to walk there instead.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'goToPlayer',
    description: 'Walk to a named player and stop near them.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        range: { type: 'number', description: 'How close to stop (blocks). Default 2.' },
      },
      required: ['username'],
    },
  },
  {
    name: 'followPlayer',
    description: 'Continuously follow a player until told to stop.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        range: { type: 'number', description: 'Follow distance (blocks). Default 2.' },
      },
      required: ['username'],
    },
  },
  {
    name: 'stop',
    description: 'Stop all movement and cancel the current goal.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'lookDirection',
    description: 'Turn to face a cardinal direction (north, south, east, west). Also sets the orientation of blocks placed next, e.g. stairs.',
    input_schema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] } },
      required: ['direction'],
    },
  },
  {
    name: 'mineNearestBlock',
    description: 'Find and mine the nearest block(s) of a given type, e.g. "oak_log", "stone", "coal_ore".',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        count: { type: 'number', description: 'How many to mine. Default 1.' },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'digTestTunnel',
    description: 'Walk forward to the wall ahead, then mine a 1-wide, 2-high tunnel straight forward at the current level, up to the given number of blocks deep, placing a torch every 10 blocks (needs torches in inventory). Stops early if it breaks into open air, water, or lava. Equip a pickaxe first for stone.',
    input_schema: {
      type: 'object',
      properties: {
        depth: { type: 'number', description: 'How many blocks deep to dig. Default 5.' },
      },
    },
  },
  {
    name: 'digBlock',
    description: 'Mine the single block at exact coordinates. Pair with findBlocks: locate a block, then dig it. Equip the right tool first for ores/hard blocks.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'equipItem',
    description: 'Equip an item from the inventory into the main hand, e.g. "stone_pickaxe".',
    input_schema: {
      type: 'object',
      properties: { itemName: { type: 'string' } },
      required: ['itemName'],
    },
  },
  {
    name: 'dropItem',
    description: 'Drop (toss) items from the inventory onto the ground, e.g. give items to a player by dropping near them.',
    input_schema: {
      type: 'object',
      properties: {
        itemName: { type: 'string' },
        count: { type: 'number', description: 'How many to drop. Default: the whole stack.' },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'placeBlock',
    description: 'Place a single block from the inventory at the given coordinates. Build structures by calling this repeatedly for each block. Needs a solid block already adjacent to place against.',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['blockName', 'x', 'y', 'z'],
    },
  },
  {
    name: 'fillArea',
    description: 'Fill a solid rectangular box between two corner coordinates with a block, in one call (e.g. floors, platforms, solid cubes). Max 512 blocks per call.',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        x1: { type: 'number' },
        y1: { type: 'number' },
        z1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        z2: { type: 'number' },
      },
      required: ['blockName', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
    },
  },
  {
    name: 'buildWall',
    description: 'Build a straight wall in one call. Starts at (x, y, z), runs `length` blocks along the chosen horizontal axis and `height` blocks up. Max 512 blocks per call.',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        direction: { type: 'string', enum: ['x', 'z'], description: 'Horizontal axis the wall runs along. Default "x".' },
        length: { type: 'number', description: 'Wall length in blocks.' },
        height: { type: 'number', description: 'Wall height in blocks. Default 1.' },
      },
      required: ['blockName', 'x', 'y', 'z', 'length'],
    },
  },
  {
    name: 'fillPit',
    description: 'Fill in the pit/hole the bot is currently standing in, up to the surrounding ground level, using the same block type the bot is standing on. The matching block must be in inventory.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'plantField',
    description: 'For every grass block at the bot\'s current level within range, hoe it into farmland with the iron_hoe and plant the given seed (e.g. "wheat_seeds"). Needs an iron_hoe and the seeds in inventory.',
    input_schema: {
      type: 'object',
      properties: { seedName: { type: 'string', description: 'Seed/crop item to plant, e.g. wheat_seeds, beetroot_seeds, carrot, potato.' } },
      required: ['seedName'],
    },
  },
  {
    name: 'mineArea',
    description: 'Mine out every block inside a rectangular box between two corner coordinates, top-down, in one call (e.g. clear a single rock layer or dig a pit). Optionally restrict to one block type. Max 512 blocks per call.',
    input_schema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        z1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        z2: { type: 'number' },
        blockName: { type: 'string', description: 'Optional: only mine blocks of this type, leaving others.' },
      },
      required: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
    },
  },
  {
    name: 'fillSpan',
    description: 'Fill the rectangle marked by the bot and the nearest player as opposite corners (you stand at the far corner). Fills from feet level up. Optional height (default 1).',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        height: { type: 'number', description: 'Layers tall. Default 1.' },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'mineSpan',
    description: 'Mine out the rectangle marked by the bot and the nearest player as opposite corners. Mines from the ground you stand on downward. Optional depth (default 1).',
    input_schema: {
      type: 'object',
      properties: { depth: { type: 'number', description: 'Layers deep. Default 1.' } },
    },
  },
  {
    name: 'wallSpan',
    description: 'Build a straight wall between the bot and the nearest player (along the longer axis), sitting on the ground. Optional height (default 1).',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        height: { type: 'number', description: 'Wall height. Default 1.' },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'lookAt',
    description: 'Turn to look directly at a specific coordinate. Useful for aiming before using an item or precise placement.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'lookAtMe',
    description: 'Turn to face a player (defaults to the nearest one). Pass a username to face a specific player.',
    input_schema: {
      type: 'object',
      properties: { username: { type: 'string', description: 'Optional player to face. Defaults to nearest.' } },
    },
  },
  {
    name: 'chitchat',
    description: 'Socialize: for ~30 seconds, glance back and forth between the other bot(s) and a player, holding a few seconds on each — looks like conversation. Run on multiple bots for the full effect.',
    input_schema: {
      type: 'object',
      properties: {
        durationSec: { type: 'number', description: 'How long to chitchat. Default 30, max 120.' },
        username: { type: 'string', description: 'The player to glance at between peers (defaults to whoever asked).' },
      },
    },
  },
  {
    name: 'move',
    description: 'Move relative to the way the bot is currently facing: forward, back, left, or right (f/b/l/r) by a number of blocks. E.g. "go forward 5".',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['forward', 'back', 'left', 'right', 'f', 'b', 'l', 'r'] },
        distance: { type: 'number', description: 'How many blocks. Default 1.' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'turn',
    description: 'Turn to look in a direction relative to current facing: forward, back (around), left, or right (f/b/l/r).',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['forward', 'back', 'left', 'right', 'f', 'b', 'l', 'r'] },
      },
      required: ['direction'],
    },
  },
  {
    name: 'jump',
    description: 'Jump up and hop one block in a direction relative to current facing (forward/back/left/right, f/b/l/r). Use to climb a one-block step.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['forward', 'back', 'left', 'right', 'f', 'b', 'l', 'r'] },
      },
      required: ['direction'],
    },
  },
  {
    name: 'findBlocks',
    description: 'Locate nearby blocks by name and get their coordinates. Use to find ores, water, trees, chests, etc. before mining/filling/interacting. Partial names match broadly (e.g. "ore" finds all ores, "iron" finds iron ore variants).',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        range: { type: 'number', description: 'Search radius in blocks. Default 32.' },
        count: { type: 'number', description: 'Max results to return. Default 8.' },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'attackEntity',
    description: 'Attack an entity until it dies or flees. Give a target name (e.g. "zombie", "cow", or a player name) to attack the nearest match; omit it to attack the nearest hostile mob.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Entity name to attack. Omit for nearest hostile mob.' } },
    },
  },
  {
    name: 'eat',
    description: 'Eat food to restore hunger. Give a food name, or omit to eat any food in the inventory.',
    input_schema: {
      type: 'object',
      properties: { foodName: { type: 'string', description: 'Optional food item name, e.g. "bread".' } },
    },
  },
  {
    name: 'useItem',
    description: 'Use (right-click) the currently held item, e.g. fill/empty a bucket while looking at water, drink a potion, throw an ender pearl, use a fishing rod. Equip the item first.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'collectItems',
    description: 'Walk to and pick up nearby dropped item stacks on the ground.',
    input_schema: {
      type: 'object',
      properties: { range: { type: 'number', description: 'Search radius in blocks. Default 16.' } },
    },
  },
  {
    name: 'harvestAndCollect',
    description: 'Harvest in one step: mine all nearby blocks of a type (e.g. "pumpkin", "wheat", "melon") and pick up the drops.',
    input_schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        count: { type: 'number', description: 'Max blocks to harvest. Default 64.' },
      },
      required: ['blockName'],
    },
  },
  {
    name: 'replaceField',
    description: 'Replace the floor of the field the bot stands on (the flat area enclosed by walls, same boundary as plantField) with another block: digs each floor block and places the given block in its place. Needs the block in inventory.',
    input_schema: {
      type: 'object',
      properties: { blockName: { type: 'string', description: 'The block to lay down, e.g. "cobblestone".' } },
      required: ['blockName'],
    },
  },
  {
    name: 'activateBlock',
    description: 'Right-click / use a block at coordinates: open doors, press buttons, flip levers, open chests, etc.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'craftItem',
    description: 'Craft an item from inventory ingredients. Uses a nearby crafting table for 3x3 recipes if one is within 16 blocks.',
    input_schema: {
      type: 'object',
      properties: {
        itemName: { type: 'string' },
        count: { type: 'number', description: 'How many to craft. Default 1.' },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'depositToChest',
    description: 'Deposit items into nearby chests/barrels, starting with the nearest and overflowing to the next nearest when one fills. Coordinates are optional — give them to start at a specific chest. Default deposits all of the item.',
    input_schema: {
      type: 'object',
      properties: {
        itemName: { type: 'string' },
        count: { type: 'number', description: 'How many to deposit. Default: all of it.' },
        x: { type: 'number', description: 'Optional: chest to start with.' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'withdrawFromChest',
    description: 'Take items out of a chest (or barrel/shulker) at the given coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        itemName: { type: 'string' },
        count: { type: 'number', description: 'How many to withdraw. Default 1.' },
      },
      required: ['x', 'y', 'z', 'itemName'],
    },
  },
]

async function dispatch(bot, name, input) {
  const fn = actions[name]
  if (!fn) return `Unknown tool: ${name}`
  return await fn(bot, input || {})
}

module.exports = { tools, dispatch }
