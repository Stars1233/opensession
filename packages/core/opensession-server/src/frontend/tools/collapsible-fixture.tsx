import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../ui/button";
import { Disclosure } from "../ui/disclosure";
import { Fold } from "../ui/fold";

function CollapsibleFixture() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const [lines, setLines] = useState(1);
  return (
    <main className="bg-surface p-4 text-fg">
      <h1>Open Session disclosure regression</h1>
      <Button onClick={() => setOpen(!open)}>Toggle work</Button>
      <Button onClick={() => setLines(lines + 20)}>Append output</Button>
      <section data-outer>
        <Fold open={open}>
          <div>
            <Button onClick={() => setNested(!nested)}>Toggle step</Button>
            <section data-inner>
              <Fold open={nested}>
                <div>
                  {Array.from({ length: lines }, (_, i) => (
                    <p key={i}>Tool output line {i + 1}</p>
                  ))}
                </div>
              </Fold>
            </section>
            <p>Last step</p>
          </div>
        </Fold>
      </section>
      <p data-after>After work</p>
      <Disclosure title="Initially open" defaultOpen>
        <p>Visible on mount</p>
      </Disclosure>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<CollapsibleFixture />);
