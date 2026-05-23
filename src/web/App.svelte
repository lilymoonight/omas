<script lang="ts">
  import { onMount } from 'svelte';
  import { route, navigate } from './lib/router.js';
  import { auth, checkAuth } from './lib/stores.js';
  import List from './routes/List.svelte';
  import Terminal from './routes/Terminal.svelte';
  import Login from './routes/Login.svelte';
  import History from './routes/History.svelte';

  let current = $state($route);
  route.subscribe((r) => (current = r));

  let authState = $state($auth);
  auth.subscribe((a) => {
    authState = a;
    if (a === 'out' && current.name !== 'login') navigate({ name: 'login' });
    if (a === 'in' && current.name === 'login') navigate({ name: 'list' });
  });

  onMount(checkAuth);
</script>

{#if authState === 'unknown'}
  <main class="boot"></main>
{:else if authState === 'out'}
  <Login />
{:else if current.name === 'list'}
  <List />
{:else if current.name === 'terminal'}
  {#key current.id}
    <Terminal sessionId={current.id} />
  {/key}
{:else if current.name === 'history'}
  <History />
{:else if current.name === 'login'}
  <Login />
{/if}

<style>
  .boot {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
  }
</style>
