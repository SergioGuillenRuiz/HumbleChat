// Pantalla de primer arranque cuando la aplicación no trae la llave: se pide el código de sala.
const $ = (id) => document.getElementById(id)
const error = (msg) => { $('error').textContent = msg || '' }

async function join(code) {
  error('')
  $('join').disabled = true
  try { await window.humble.roomJoin(code) } catch (e) {
    error(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    $('join').disabled = false
  }
}

$('join').addEventListener('click', () => join($('code').value))
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('code').value) })

let created = null
$('create').addEventListener('click', async () => {
  created = await window.humble.roomCreate()
  $('newcode').textContent = created
  $('created').classList.remove('hidden')
})
$('copy').addEventListener('click', () => { navigator.clipboard.writeText(created); $('copy').textContent = 'Copiado' })
$('go').addEventListener('click', () => join(created))
