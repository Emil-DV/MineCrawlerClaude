require('dotenv').config()
const mineflayer = require('mineflayer')
const sleep = ms=>new Promise(r=>setTimeout(r,ms))
const bot = mineflayer.createBot({host:'localhost',port:25565,username:'kaikdidk',version:'1.21.4',auth:'offline'})
bot.on('error',e=>console.log('ERR',e.message))
const P=()=>{const p=bot.entity.position;return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`}
bot.once('spawn', async ()=>{
  await sleep(1000)
  bot.chat('/op WpBot'); await sleep(800)
  // go to a known spot, save it
  bot.chat('/tp kaikdidk 250 100 250'); await sleep(1500)
  console.log('at home spot:', P())
  bot.chat('saveWaypoint spot1'); await sleep(1800)
  // move far away, verify moved
  bot.chat('/tp kaikdidk 250 100 350'); await sleep(1800)
  console.log('moved away to:', P())
  // tpMe back
  bot.chat('tpMe spot1'); await sleep(2000)
  console.log('after tpMe spot1:', P())
  console.log(P()==='250,100,250' ? 'PASS: tpMe brought me back to the waypoint' : 'FAIL')
  bot.quit(); process.exit(0)
})
