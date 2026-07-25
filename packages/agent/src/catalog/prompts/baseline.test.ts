/**
 * Baseline system prompt tests.
 *
 * Verifies the prompt assembly: core content + correct model overlay +
 * optional environment/customInstructions/skills sections, in the right
 * order. Mirrors how open-agents tests their own prompt composer.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBaselineSystemPrompt,
  type BaselineSkillMetadata,
} from './baseline';

describe('buildBaselineSystemPrompt', () => {
  describe('core content', () => {
    it('always includes core operating principles', () => {
      const prompt = buildBaselineSystemPrompt();
      expect(prompt).toContain('autonomous AI agent');
      expect(prompt).toContain('# Task Persistence');
      expect(prompt).toContain('# Tool Usage');
      expect(prompt).toContain('# Verification Loop');
      expect(prompt).toContain('# Security');
    });

    it('includes filesystem tool documentation', () => {
      const prompt = buildBaselineSystemPrompt();
      expect(prompt).toContain('`read`');
      expect(prompt).toContain('`write`');
      expect(prompt).toContain('`edit`');
      expect(prompt).toContain('`grep`');
      expect(prompt).toContain('`glob`');
    });

    it('includes ask_user_question and todo_write tools', () => {
      const prompt = buildBaselineSystemPrompt();
      expect(prompt).toContain('`ask_user_question`');
      expect(prompt).toContain('`todo_write`');
    });
  });

  describe('model overlays', () => {
    it('selects Claude overlay for claude model IDs', () => {
      const prompt = buildBaselineSystemPrompt({
        modelId: 'anthropic/claude-sonnet-4.5',
      });
      expect(prompt).toContain('Claude-specific');
      expect(prompt).not.toContain('GPT-specific');
      expect(prompt).not.toContain('Gemini-specific');
    });

    it('selects GPT overlay for gpt model IDs', () => {
      const prompt = buildBaselineSystemPrompt({
        modelId: 'openai/gpt-4o',
      });
      expect(prompt).toContain('GPT-specific');
      expect(prompt).not.toContain('Claude-specific');
    });

    it('selects Gemini overlay for gemini model IDs', () => {
      const prompt = buildBaselineSystemPrompt({
        modelId: 'google/gemini-2.0-flash',
      });
      expect(prompt).toContain('Gemini-specific');
    });

    it('selects "other" overlay for unknown model IDs', () => {
      const prompt = buildBaselineSystemPrompt({
        modelId: 'fictional/model-x',
      });
      expect(prompt).toContain('Model-specific');
      expect(prompt).not.toContain('Claude-specific');
      expect(prompt).not.toContain('GPT-specific');
    });

    it('selects "other" overlay when no modelId provided', () => {
      const prompt = buildBaselineSystemPrompt();
      expect(prompt).toContain('Model-specific');
    });

    it('appends GPT-5.4 overlay for openai/gpt-5.4 models', () => {
      const prompt = buildBaselineSystemPrompt({
        modelId: 'openai/gpt-5.4',
      });
      expect(prompt).toContain('GPT-specific');       // base GPT overlay
      expect(prompt).toContain('GPT-5.4-specific');   // additional layer
    });
  });

  describe('environment details', () => {
    it('appends environment section when provided', () => {
      const prompt = buildBaselineSystemPrompt({
        environmentDetails: 'Sandbox: isolated-vm\nWorking directory: /scratch',
      });
      expect(prompt).toContain('# Environment');
      expect(prompt).toContain('Sandbox: isolated-vm');
    });

    it('skips environment section when not provided', () => {
      const prompt = buildBaselineSystemPrompt();
      expect(prompt).not.toContain('# Environment');
    });
  });

  describe('custom instructions', () => {
    it('appends project-specific instructions when provided', () => {
      const prompt = buildBaselineSystemPrompt({
        customInstructions: 'Always use the brand color palette.',
      });
      expect(prompt).toContain('# Project-Specific Instructions');
      expect(prompt).toContain('Always use the brand color palette.');
    });
  });

  describe('skills', () => {
    it('lists invocable skills with descriptions', () => {
      const skills: BaselineSkillMetadata[] = [
        { name: 'render-chart', description: 'Generate D3 charts inline' },
        { name: 'export-pdf', description: 'Export the current deck as PDF' },
      ];
      const prompt = buildBaselineSystemPrompt({ skills });
      expect(prompt).toContain('## Skills');
      expect(prompt).toContain('render-chart: Generate D3 charts inline');
      expect(prompt).toContain('export-pdf: Export the current deck as PDF');
    });

    it('marks model-only skills with "(model-only)" suffix', () => {
      const skills: BaselineSkillMetadata[] = [
        {
          name: 'auto-attribute',
          description: 'Add citations',
          options: { userInvocable: false },
        },
      ];
      const prompt = buildBaselineSystemPrompt({ skills });
      expect(prompt).toContain('auto-attribute: Add citations (model-only)');
    });

    it('omits skills disabled for model invocation', () => {
      const skills: BaselineSkillMetadata[] = [
        { name: 'visible', description: 'shown' },
        {
          name: 'hidden',
          description: 'hidden',
          options: { disableModelInvocation: true },
        },
      ];
      const prompt = buildBaselineSystemPrompt({ skills });
      expect(prompt).toContain('visible: shown');
      expect(prompt).not.toContain('hidden: hidden');
    });

    it('skips skills section entirely when no invocable skills remain', () => {
      const skills: BaselineSkillMetadata[] = [
        {
          name: 'hidden',
          description: 'hidden',
          options: { disableModelInvocation: true },
        },
      ];
      const prompt = buildBaselineSystemPrompt({ skills });
      expect(prompt).not.toContain('## Skills');
    });

    it('skips skills section when skills array is empty', () => {
      const prompt = buildBaselineSystemPrompt({ skills: [] });
      expect(prompt).not.toContain('## Skills');
    });

    it('detects slash command pattern in instructions', () => {
      const skills: BaselineSkillMetadata[] = [
        { name: 'commit', description: 'commit changes' },
      ];
      const prompt = buildBaselineSystemPrompt({ skills });
      expect(prompt).toContain('/<name>');
      expect(prompt).toContain('FIRST tool call MUST be the skill tool');
    });
  });

  describe('assembly order', () => {
    it('places sections in the documented order', () => {
      const prompt = buildBaselineSystemPrompt({
        modelId: 'anthropic/claude-sonnet-4.5',
        environmentDetails: 'env-marker',
        customInstructions: 'project-marker',
        skills: [{ name: 'sk', description: 'skill-marker' }],
      });

      const idxCore = prompt.indexOf('autonomous AI agent');
      const idxOverlay = prompt.indexOf('Claude-specific');
      const idxEnv = prompt.indexOf('env-marker');
      const idxProject = prompt.indexOf('project-marker');
      const idxSkills = prompt.indexOf('skill-marker');

      expect(idxCore).toBeGreaterThanOrEqual(0);
      expect(idxOverlay).toBeGreaterThan(idxCore);
      expect(idxEnv).toBeGreaterThan(idxOverlay);
      expect(idxProject).toBeGreaterThan(idxEnv);
      expect(idxSkills).toBeGreaterThan(idxProject);
    });
  });

  describe('composition with domain prompts', () => {
    it('output is a string that can be concatenated with domain content', () => {
      const baseline = buildBaselineSystemPrompt({
        modelId: 'anthropic/claude-sonnet-4.5',
      });
      const domainPrompt = '# Deck Domain\n\nYou are editing a slide deck.';
      const fullPrompt = [baseline, domainPrompt].join('\n\n');

      expect(fullPrompt).toContain('autonomous AI agent');
      expect(fullPrompt).toContain('Deck Domain');
      // Domain prompt comes after baseline
      expect(fullPrompt.indexOf('autonomous AI agent')).toBeLessThan(
        fullPrompt.indexOf('Deck Domain'),
      );
    });
  });
});
