import contextFactory from '@oldcord/frontend-shared/hooks/contextFactory';
import { useEffect, useState, useCallback } from 'react';

export const TRUST_LEVELS = {
  TRUSTED: 'TRUSTED',
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
};

const getTrustLevel = (plugin) => {
  if (plugin.verified === true) {
    return TRUST_LEVELS.VERIFIED;
  }
  if (plugin.trusted === true) {
    return TRUST_LEVELS.TRUSTED;
  }
  return TRUST_LEVELS.UNVERIFIED;
};

const validatePlugin = (plugin) => {
  const errors = [];
  if (!plugin.id) {
    errors.push('Plugin ID is required');
  }
  if (!plugin.name) {
    errors.push('Plugin name is required');
  }
  if (!plugin.version) {
    errors.push('Plugin version is required');
  }
  return {
    valid: errors.length === 0,
    errors,
  };
};

const checkPluginSignature = async (plugin) => {
  if (plugin.verified) {
    return { valid: true, verified: true };
  }
  if (!plugin.signature && !plugin.sourceUrl) {
    return { valid: false, verified: false, reason: 'No signature or source URL provided' };
  }
  return { valid: true, verified: false };
};

const getPluginSecurityFlags = (plugin) => {
  const trustLevel = getTrustLevel(plugin);
  return {
    isVerified: plugin.verified === true,
    isTrusted: plugin.trusted === true,
    trustLevel,
    hasSignature: !!plugin.signature,
    hasSourceUrl: !!plugin.sourceUrl,
    isAuthorVerified: plugin.authorVerified === true,
    requiresWarning: trustLevel === TRUST_LEVELS.UNVERIFIED,
  };
};

const shouldShowUnverifiedWarning = (plugin) => {
  const trustLevel = getTrustLevel(plugin);
  return trustLevel === TRUST_LEVELS.UNVERIFIED;
};

async function fetchOldPlungerPlugins() {
  try {
    const response = await fetch(
      `${location.protocol}//${location.host}/assets/oldplunger/plugins.json`,
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (data && Array.isArray(data.plugins)) {
      data.plugins = data.plugins.map((plugin) => ({
        ...plugin,
        sourceUrl: plugin.sourceUrl || null,
        authorVerified: plugin.authorVerified || false,
      }));
    }
    return data;
  } catch (error) {
    console.error('Failed to fetch plunger plugins:', error);
    return null;
  }
}

function useOldplungerPluginsState() {
  const [plugins, setPlugins] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unverifiedWarnings, setUnverifiedWarnings] = useState(new Set());

  const showUnverifiedWarning = useCallback((pluginId) => {
    setUnverifiedWarnings((prev) => new Set([...prev, pluginId]));
  }, []);

  const dismissUnverifiedWarning = useCallback((pluginId) => {
    setUnverifiedWarnings((prev) => {
      const next = new Set(prev);
      next.delete(pluginId);
      return next;
    });
  }, []);

function useOldplungerPluginsState() {
  const [plugins, setPlugins] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadPlugins = async () => {
      setLoading(true);
      const data = await fetchOldPlungerPlugins();
      if (data) {
        setPlugins(data);
      } else {
        console.log('Failed to load plugins.');
      }
      setLoading(false);
    };

    loadPlugins();
  }, []);

  return {
    plugins,
    loading,
    unverifiedWarnings,
    showUnverifiedWarning,
    dismissUnverifiedWarning,
    validatePlugin,
    checkPluginSignature,
    getPluginSecurityFlags,
    getTrustLevel,
    shouldShowUnverifiedWarning,
    TRUST_LEVELS,
  };
}

const { Provider, useContextHook } = contextFactory(useOldplungerPluginsState);

const useOldplungerPluginsEnhanced = () => {
  const context = useContextHook();

  const getFilteredPlugins = useCallback(
    (trustLevel = null) => {
      if (!context.plugins?.plugins) return [];
      if (!trustLevel) return context.plugins.plugins;
      return context.plugins.plugins.filter(
        (plugin) => getTrustLevel(plugin) === trustLevel,
      );
    },
    [context.plugins],
  );


  const getVerifiedPlugins = useCallback(() => {
    return getFilteredPlugins(TRUST_LEVELS.VERIFIED);
  }, [getFilteredPlugins]);

  const getUnverifiedPlugins = useCallback(() => {
    return getFilteredPlugins(TRUST_LEVELS.UNVERIFIED);
  }, [getFilteredPlugins]);

  return {
    ...context,
    getFilteredPlugins,
    getVerifiedPlugins,
    getUnverifiedPlugins,
  };
};

export const OldplungerPluginsHandler = Provider;
export const useOldplugerPlugins = useContextHook;
export const useOldplugerPluginsEnhanced = useOldplungerPluginsEnhanced;
