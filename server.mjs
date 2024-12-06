import express from 'express';
import { URL } from 'url';
import lighthouse from 'lighthouse';
import { co2 } from '@tgwf/co2';
import cors from 'cors';
import NodeCache from 'node-cache';
import fetch from 'node-fetch';

const chromeLauncher = await import('chrome-launcher');
const app = express();
app.use(express.static('public'));
app.use(cors());

const cache = new NodeCache({ stdTTL: 3600 });
const sustainableWebDesign = new co2({ model: 'swd' });

async function checkGreenHosting(domain) {
  try {
    const response = await fetch(`https://api.thegreenwebfoundation.org/api/v3/greencheck/${domain}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Green hosting check failed with status: ${response.status}`);
    }

    const data = await response.json();
    return {
      isGreen: data.green || false,
      hosted_by: data.hostedby || 'Unknown',
      hosted_by_website: data.hostedbywebsite || null,
      partner: data.partner || false,
    };
  } catch (error) {
    console.error('Error checking green hosting status:', error);
    return {
      isGreen: false,
      hosted_by: 'Unknown',
      hosted_by_website: null,
      partner: false,
      error: error.message,
    };
  }
}

function isValidURL(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function getSafeValue(obj, path, defaultValue = null) {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj) ?? defaultValue;
}

function removeDuplicateSuggestions(suggestions) {
  const seenTitles = new Set();
  return suggestions.filter(suggestion => {
    if (seenTitles.has(suggestion.title)) {
      return false;
    }
    seenTitles.add(suggestion.title);
    return true;
  });
}

app.get('/analyze', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  if (!isValidURL(url)) {
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  const cachedResult = cache.get(url);
  if (cachedResult) {
    return res.json(cachedResult);
  }

  let chrome;
  try {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname;
    const greenHostingResult = await checkGreenHosting(domain);

    chrome = await chromeLauncher.launch({ chromeFlags: ['--headless'] });
    const runnerResult = await lighthouse(url, {
      logLevel: 'info',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      port: chrome.port,
    });
    const reportJson = JSON.parse(runnerResult.report);

    const dataTransferSize = getSafeValue(reportJson, 'audits.total-byte-weight.numericValue', 0);
    const emissions = sustainableWebDesign.perByte(dataTransferSize);
    const roundedEmissions = emissions.toFixed(3);

    let suggestions = reportJson.audits
      ? Object.values(reportJson.audits)
          .filter(audit => audit.details && audit.details.type === 'opportunity')
          .flatMap(audit => audit.details.items.map(item => ({
            title: audit.title || 'N/A',
            description: audit.description || 'N/A',
            savings: item.wastedMs ? `${item.wastedMs}ms` : 'N/A',
          })))
      : [];

    suggestions = removeDuplicateSuggestions(suggestions);

    if (greenHostingResult.isGreen) {
      suggestions.unshift({
        title: '🌱 Excellent Green Hosting Choice!',
        description: `Your website is hosted by ${greenHostingResult.hosted_by}, a green hosting provider.`,
        savings: 'Environmental Impact',
        type: 'success',
      });
    } else {
      suggestions.unshift({
        title: 'Consider Green Hosting',
        description: `Currently hosted by ${greenHostingResult.hosted_by}. Consider switching to a green hosting provider.`,
        savings: 'Environmental Impact',
        type: 'improvement',
      });
    }

    const response = {
      url,
      emissions: roundedEmissions,
      dataTransferSize,
      greenHosting: {
        ...greenHostingResult,
        domain,
        message: greenHostingResult.isGreen
          ? '🌱 This website is hosted green!'
          : 'This website is not hosted green!',
      },
      lighthouse: {
        performance: getSafeValue(reportJson, 'categories.performance.score', 0) * 100,
        accessibility: getSafeValue(reportJson, 'categories.accessibility.score', 0) * 100,
        bestPractices: getSafeValue(reportJson, 'categories.best-practices.score', 0) * 100,
        seo: getSafeValue(reportJson, 'categories.seo.score', 0) * 100,
      },
      metrics: {
        firstContentfulPaint: getSafeValue(reportJson, 'audits.first-contentful-paint.displayValue', 'N/A'),
        speedIndex: getSafeValue(reportJson, 'audits.speed-index.displayValue', 'N/A'),
        largestContentfulPaint: getSafeValue(reportJson, 'audits.largest-contentful-paint.displayValue', 'N/A'),
        timeToInteractive: getSafeValue(reportJson, 'audits.interactive.displayValue', 'N/A'),
        totalBlockingTime: getSafeValue(reportJson, 'audits.total-blocking-time.displayValue', 'N/A'),
      },
      improvements: suggestions,
      timestamp: new Date().toISOString(),
    };

    cache.set(url, response);
    res.json(response);
  } catch (error) {
    console.error('Error analyzing website:', error);
    res.status(500).json({
      error: 'Failed to analyze website',
      details: error.message,
      url,
    });
  } finally {
    if (chrome) {
      await chrome.kill();
    }
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
