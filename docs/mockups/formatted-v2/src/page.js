// ---- boot: render the page, the table of contents, the theme toggle ---------------------------------------------------------------
;(function boot() {
  const main = document.getElementById('app')
  main.innerHTML = build().join('')
  document.getElementById('toc-list').innerHTML = TOC.map(([id, n, t]) => `<li><a href="#${id}" data-id="${id}"><span class="n">${n}</span><span>${t}</span></a></li>`).join('')

  // scroll-spy: the section under the top of the viewport is the current one in the table of contents
  const links = [...document.querySelectorAll('.toc a')]
  const secs = TOC.map(([id]) => document.getElementById(id))
  const spy = () => {
    let cur = 0
    secs.forEach((s, i) => { if (s && s.getBoundingClientRect().top < 120) cur = i })
    links.forEach((a, i) => a.classList.toggle('on', i === cur))
  }
  addEventListener('scroll', spy, { passive: true }); spy()

  // theme: auto (the system), light, dark; data-theme on <html>
  const root = document.documentElement, btn = document.getElementById('theme'), label = document.getElementById('theme-label')
  const modes = ['auto', 'light', 'dark']
  let mode = 'auto'
  try { mode = localStorage.getItem('mtk-mock-theme') || 'auto' } catch (e) {}
  const apply = () => { if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode); label.textContent = mode[0].toUpperCase() + mode.slice(1) }
  btn.addEventListener('click', () => { mode = modes[(modes.indexOf(mode) + 1) % 3]; try { localStorage.setItem('mtk-mock-theme', mode) } catch (e) {} apply() })
  apply()
})()
