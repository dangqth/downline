import Vue from 'vue';
import Vuex from 'vuex';

const { ipcRenderer } = window.require('electron');

import api from './lib/api.js';
import db from './lib/db.js';
import State from './lib/state.js';

Vue.use(Vuex);

const store = new Vuex.Store({
  state: {
    downloadables: db.get('downloadables'),
    nLoading: 0,
    isOpen: false,
    message: '',
    success: null,
    globalQualityIndex: 0
  },
  getters: {
    downloadables: state => state.downloadables,
    isLoading: state => state.nLoading > 0,
    count: state => state.downloadables.length,
    canDownloadMany: state => {
      return state.downloadables.some(
        x => State.isStopped(x.state) || State.isPaused(x.state)
      );
    },
    isAllAudioChosen: state => {
      return !state.downloadables.some(
        x => !x.formats[x.formatIndex].isAudioOnly
      );
    },
    globalQuality: (state, getters) => {
      let formats = [];
      let seen = new Set();
      state.downloadables.forEach(item => {
        item.formats.forEach(format => {
          const key = format.quality + format.suffix;
          if (
            !seen.has(key) &&
            format.isAudioOnly === getters.isAllAudioChosen
          ) {
            formats.push({ ...format });
            seen.add(key);
          }
        });
      });

      const compare = (x, y) => {
        const a = parseInt(x.quality);
        const b = parseInt(y.quality);

        if (!isNaN(a) && !isNaN(b)) {
          // If both a and b are numbers, the larger one comes first
          return b - a;
        } else if (!isNaN(a)) {
          // If a is number but b is not, b comes first
          return 1;
        } else if (!isNaN(b)) {
          // If b is a number but a is not, a comes first
          return -1;
        }
        // If neither a nor b are numbers, leave unchanged
        return 0;
      };

      formats.sort(compare);

      return formats;
    },
    globalQualityIndex: state => state.globalQualityIndex,
    isConfirmOpen: state => state.isOpen,
    confirmMessage: state => state.message
  },
  mutations: {
    openConfirm(state, { message, success }) {
      state.isOpen = true;
      state.message = message;
      state.success = success;
    },
    closeConfirm(state, result) {
      state.isOpen = false;
      if (result) {
        state.success();
      }
      state.message = '';
      state.success = null;
    },
    add(state, data) {
      state.downloadables.push(data);
    },
    remove(state, index) {
      state.downloadables.splice(index, 1);
    },
    updateState(state, { index, value }) {
      state.downloadables[index].state = value;
    },
    updateProgress(state, { index, value }) {
      state.downloadables[index].progress = value;
    },
    updateFormatIndex(state, { index, value }) {
      state.downloadables[index].formatIndex = value;
    },
    updateFilepath(state, { index, value }) {
      state.downloadables[index].filepath = value;
    },
    updateLoading(state, newValue) {
      state.nLoading += newValue;
    },
    updateGlobalQualityIndex(state, newValue) {
      state.globalQualityIndex = newValue;
    }
  },
  actions: {
    setManyQuality({ commit, state }, { quality, suffix }) {
      const key = quality + suffix;

      for (let index = 0; index < state.downloadables.length; index++) {
        const value = state.downloadables[index].formats.findIndex(
          format => format.quality + format.suffix === key
        );
        if (value !== -1) {
          commit('updateFormatIndex', { index, value });
        }
      }
    },
    add({ commit }, links) {
      commit('updateLoading', 1);

      const info = api.fetchInfo(links);
      info.on('data', data => {
        if (
          data.formats != null &&
          data.formats.length !== 0 &&
          getIndex(data.url) === -1
        ) {
          commit('add', data);
        }
      });

      info.on('end', () => commit('updateLoading', -1));
    },
    remove({ state, dispatch, commit }, url) {
      const index = getIndex(url);

      if (index !== -1) {
        const itemState = state.downloadables[index].state;
        if (
          State.isStarting(itemState) ||
          State.isDownloading(itemState) ||
          State.isProcessing(itemState) ||
          State.isQueued(itemState)
        ) {
          dispatch('pause', url);
        }
        commit('remove', index);
      }
    },
    download({ state, commit }, url) {
      let index = getIndex(url);

      const { formats, formatIndex, playlist } = state.downloadables[index];
      const args = { url, playlist, format: formats[formatIndex] };

      const process = api.download(args);

      if (process === null) {
        commit('updateState', { index, value: State.QUEUED });
        return;
      }

      commit('updateState', { index, value: State.STARTING });

      process.on('data', data => {
        const index = getIndex(url);
        if (data === 'processing') {
          commit('updateState', { index, value: State.PROCESSING });
        } else if (data !== '') {
          commit('updateState', { index, value: State.DOWNLOADING });
          commit('updateProgress', { index, value: data });
        }
      });

      process.on('end', () => {
        index = getIndex(url);
        if (!State.isPaused(state.downloadables[index].state)) {
          commit('updateState', { index, value: State.COMPLETED });
        }
      });
    },
    pause({ commit }, url) {
      const index = getIndex(url);
      commit('updateState', { index, value: State.PAUSED });
      api.pause(url);
    },
    reload({ commit }, url) {
      const index = getIndex(url);
      commit('updateState', { index, value: State.STOPPED });
      commit('updateProgress', { index, value: null });
    },
    updateFilepath({ commit }, { url, filepath }) {
      const index = getIndex(url);
      commit('updateFilepath', { index, value: filepath });
    },
    downloadMany({ state, dispatch }) {
      state.downloadables.forEach(item => {
        if (State.isStopped(item.state) || State.isPaused(item.state)) {
          dispatch('download', item.url);
        }
      });
    },
    pauseMany({ state, dispatch }) {
      state.downloadables.forEach(item => {
        if (
          !State.isStopped(item.state) &&
          !State.isPaused(item.state) &&
          !State.isCompleted(item.state)
        ) {
          dispatch('pause', item.url);
        }
      });
    },
    clearMany({ state, dispatch }, shouldClearAll) {
      let urls = state.downloadables;
      if (!shouldClearAll) {
        urls = urls.filter(x => State.isCompleted(x.state));
      }

      urls = urls.map(x => x.url);
      urls.forEach(url => dispatch('remove', url));
    },
    updateFormat({ state, commit }, payload) {
      const index = getIndex(payload.url);
      const value = state.downloadables[index].formats.findIndex(
        x => x.code === payload.code
      );
      commit('updateFormatIndex', { index, value });
    },
    toggleAudioChosen({ state, commit }, payload) {
      const index = getIndex(payload.url);
      const value = state.downloadables[index].formats.findIndex(
        x => x.isAudioOnly === payload.newValue
      );
      commit('updateFormatIndex', { index, value });
    },
    toggleAllAudioChosen({ state, commit }, newValue) {
      for (let index = 0; index < state.downloadables.length; index++) {
        const { formats, formatIndex } = state.downloadables[index];

        if (formats[formatIndex].isAudioOnly === newValue) continue;

        const value = formats.findIndex(x => x.isAudioOnly === newValue);
        commit('updateFormatIndex', { index, value });
      }
    }
  }
});

function getIndex(url) {
  return store.state.downloadables.findIndex(x => x.url === url);
}

api.queueEvent.on('dequeue', url => {
  if (url) {
    store.dispatch('download', url);
  }
});

ipcRenderer.on('save', () => {
  db.set('downloadables', store.state.downloadables);
  db.update();
  ipcRenderer.send('quit');
});

export default store;
